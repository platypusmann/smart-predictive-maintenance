'use strict';

/**
 * Ramped load test.
 *
 * Drives synthetic feature vectors straight at the ingestion API in stages of
 * increasing simulated machine count, sampling every service's /metrics
 * endpoint at each stage. The output is the evidence table used in the report:
 * offered load against accepted throughput, pipeline latency and error rate.
 *
 * Posting features directly (rather than through MQTT and the edge) is
 * deliberate: this test is measuring the microservices, so the generator must
 * not be the bottleneck.
 *
 * Usage:
 *   node src/ramp.js --stages 10,50,100,250,500 --stage-seconds 60
 */

const fs = require('fs');
const path = require('path');
const { featureNames } = require('@pdm/shared');
const { SimulatedMachine, MACHINE_TYPES } = require('../../services/simulator/src/machine');
const { RollingWindow } = require('@pdm/shared');

const FEATURE_COUNT = featureNames().length;

function parseArgs(argv) {
  const args = {
    stages: [10, 50, 100, 250, 500],
    stageSeconds: 60,
    batchSize: 50,
    ingestionUrl: process.env.INGESTION_URL || 'http://localhost:3001',
    inferenceUrl: process.env.INFERENCE_URL || 'http://localhost:3002',
    alertingUrl: process.env.ALERTING_URL || 'http://localhost:3003',
    apiKey: process.env.API_KEY || 'local-dev-key',
    out: 'results',
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'stages') args.stages = value.split(',').map(Number);
    if (key === 'stage-seconds') args.stageSeconds = Number(value);
    if (key === 'batch-size') args.batchSize = Number(value);
    if (key === 'out') args.out = value;
  }
  return args;
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : { error: `HTTP ${response.status}` };
  } catch (err) {
    return { error: err.message };
  }
}

/** Build a warmed-up fleet whose windows are already full of readings. */
function buildFleet(count, seed) {
  const types = Object.keys(MACHINE_TYPES);
  const fleet = [];
  for (let i = 0; i < count; i += 1) {
    const machine = new SimulatedMachine({
      id: `LT-${String(i + 1).padStart(4, '0')}`,
      type: types[i % types.length],
      seed: seed + i * 7919,
      timeScale: 600, // compress life so degradation appears inside a short run
      forceHealthy: i % 3 === 0,
    });
    const window = new RollingWindow({ stride: 1 });
    for (let w = 0; w < 30; w += 1) window.push(machine.tick(1));
    fleet.push({ machine, window });
  }
  return fleet;
}

async function runStage(machineCount, args, stageIndex) {
  const fleet = buildFleet(machineCount, 4242 + stageIndex * 101);
  const endAt = Date.now() + args.stageSeconds * 1000;

  let sent = 0;
  let accepted = 0;
  let failed = 0;
  const latencies = [];
  let pending = [];

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const startedAt = Date.now();
    try {
      const response = await fetch(`${args.ingestionUrl}/api/v1/readings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': args.apiKey },
        body: JSON.stringify({ readings: batch }),
        signal: AbortSignal.timeout(10000),
      });
      latencies.push(Date.now() - startedAt);
      if (response.ok) {
        accepted += batch.length;
      } else {
        failed += batch.length;
      }
    } catch (err) {
      failed += batch.length;
    }
  }

  process.stdout.write(
    `\nStage ${stageIndex + 1}: ${machineCount} machines for ${args.stageSeconds}s\n`
  );

  // Each machine emits one feature vector per second of the test.
  const inFlight = [];
  const ticker = setInterval(() => {
    for (const entry of fleet) {
      const emitted = entry.window.push(entry.machine.tick(1));
      if (!emitted) continue;
      pending.push({
        machineId: entry.machine.id,
        machineType: entry.machine.type,
        timestamp: new Date().toISOString(),
        runtimeHours: entry.machine.simSeconds / 3600,
        features: emitted.features,
      });
      sent += 1;
      if (pending.length >= args.batchSize) inFlight.push(flush());
    }
  }, 1000);

  await new Promise((resolve) => setTimeout(resolve, args.stageSeconds * 1000));
  clearInterval(ticker);
  inFlight.push(flush());
  await Promise.allSettled(inFlight);

  // Give the asynchronous half of the pipeline a moment to drain.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const [ingestion, inference, alerting] = await Promise.all([
    fetchJson(`${args.ingestionUrl}/metrics`),
    fetchJson(`${args.inferenceUrl}/metrics`),
    fetchJson(`${args.alertingUrl}/metrics`),
  ]);

  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) =>
    sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

  const result = {
    stage: stageIndex + 1,
    machines: machineCount,
    durationSeconds: args.stageSeconds,
    vectorsGenerated: sent,
    vectorsAccepted: accepted,
    vectorsFailed: failed,
    offeredRatePerSecond: Number((sent / args.stageSeconds).toFixed(1)),
    acceptedRatePerSecond: Number((accepted / args.stageSeconds).toFixed(1)),
    errorRate: sent === 0 ? 0 : Number((failed / sent).toFixed(4)),
    ingestLatencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
    predictionsScored: inference.counters?.predictions_scored ?? null,
    highRiskPublished: inference.counters?.high_risk_published ?? null,
    workOrdersCreated: alerting.counters?.work_orders_created ?? null,
    inferenceLatencyMs: inference.latencyMs ?? null,
    ingestionReachable: !ingestion.error,
    inferenceReachable: !inference.error,
    alertingReachable: !alerting.error,
  };

  console.log(
    `  offered ${result.offeredRatePerSecond}/s  accepted ${result.acceptedRatePerSecond}/s  ` +
    `p95 ${result.ingestLatencyMs.p95}ms  errors ${(result.errorRate * 100).toFixed(2)}%  ` +
    `scored ${result.predictionsScored ?? 'n/a'}`
  );

  return result;
}

async function main() {
  const args = parseArgs(process.argv);

  const health = await fetchJson(`${args.ingestionUrl}/health`);
  if (health.error) {
    console.error(`Ingestion service unreachable at ${args.ingestionUrl}: ${health.error}`);
    console.error('Start the stack first: npm run start:stack');
    process.exit(1);
  }

  console.log('Load test starting');
  console.log(`  ingestion  : ${args.ingestionUrl}`);
  console.log(`  stages     : ${args.stages.join(', ')} machines`);
  console.log(`  stage time : ${args.stageSeconds}s`);
  console.log(`  features   : ${FEATURE_COUNT} per vector`);

  const results = [];
  for (const [index, machineCount] of args.stages.entries()) {
    results.push(await runStage(machineCount, args, index));
  }

  fs.mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonPath = path.join(args.out, `loadtest-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ args, results }, null, 2));

  const csvPath = path.join(args.out, `loadtest-${stamp}.csv`);
  const header =
    'stage,machines,offered_per_s,accepted_per_s,error_rate,p50_ms,p95_ms,p99_ms,predictions_scored,work_orders\n';
  const rows = results
    .map((r) =>
      [
        r.stage, r.machines, r.offeredRatePerSecond, r.acceptedRatePerSecond,
        r.errorRate, r.ingestLatencyMs.p50, r.ingestLatencyMs.p95,
        r.ingestLatencyMs.p99, r.predictionsScored ?? '', r.workOrdersCreated ?? '',
      ].join(',')
    )
    .join('\n');
  fs.writeFileSync(csvPath, header + rows + '\n');

  console.log(`\nResults written to:\n  ${jsonPath}\n  ${csvPath}`);
}

main().catch((err) => {
  console.error('Load test failed:', err.message);
  process.exit(1);
});
