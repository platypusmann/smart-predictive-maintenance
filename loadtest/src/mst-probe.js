'use strict';

// MST probe - measures the maximum sustainable throughput (MST) of a single
// inference task, following the capacity estimation approach in StreamBed
// (Rosinosky, Schmitz & Riviere, 2023): inject events at a fixed target rate
// directly at the operator under test, hold it long enough to observe steady
// state, and check whether the actual processing rate matches the injected
// rate or falls behind.
//
// We publish synthetic feature events straight onto the pdm-events/features
// topic (pdm-features queue on AWS), bypassing the simulator, edge windowing
// and ingestion entirely. This isolates the inference service's own
// throughput ceiling from everything upstream of it, the same reason
// StreamBed's Capacity Estimator attaches its rate-limited source directly to
// the query under test rather than replaying through the full pipeline.
//
// Run this against a deployment with InferenceMaxTasks (MaxCapacity in
// 02-services.yaml) pinned to 1, so there is exactly one inference task and no
// autoscaling can mask the single-task ceiling.
//
// Usage:
//   node src/mst-probe.js --rates 5,10,15,20 --stage-seconds 90 --warmup-seconds 30
//
// On AWS, also run watch-scaling.sh (or watch-queue.sh) in another terminal
// for the whole duration so queue depth is logged alongside each stage; the
// stage boundaries are timestamped to stdout so they line up with that CSV.

const { RollingWindow, TOPICS, loadConfig, messaging } = require('@pdm/shared');
const { SimulatedMachine, MACHINE_TYPES } = require('../../services/simulator/src/machine');

const config = loadConfig();

let rates = [5, 10, 15, 20, 25];
let stageSeconds = 90;
let warmupSeconds = 30;
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] === '--rates') rates = process.argv[i + 1].split(',').map(Number);
  if (process.argv[i] === '--stage-seconds') stageSeconds = Number(process.argv[i + 1]);
  if (process.argv[i] === '--warmup-seconds') warmupSeconds = Number(process.argv[i + 1]);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small pool of machines whose windows are already full, so every publish
// call has a ready, realistic 21-value feature vector on hand (same
// generation path as ramp.js, so the events look like real windowed output
// rather than arbitrary noise).
function buildFeaturePool(size = 20) {
  const types = Object.keys(MACHINE_TYPES);
  const pool = [];
  for (let i = 0; i < size; i += 1) {
    const machine = new SimulatedMachine({ id: `MST-${i + 1}`, type: types[i % types.length], seed: 5000 + i, timeScale: 600 });
    const window = new RollingWindow({ stride: 1 });
    for (let j = 0; j < 30; j += 1) window.push(machine.tick(1));
    pool.push({ machine, window });
  }
  return pool;
}

function nextFeatureEvent(pool, cursor) {
  const entry = pool[cursor % pool.length];
  const emitted = entry.window.push(entry.machine.tick(1));
  return {
    machineId: entry.machine.id,
    machineType: entry.machine.type,
    timestamp: new Date().toISOString(),
    features: emitted.features,
  };
}

// Publishes at a fixed target rate for durationSeconds. Returns the number of
// events actually published and the number of publish failures, so a probe
// run that can't even keep up with its own target rate (e.g. SQS throttling
// the injector, not the inference service) is visible rather than silently
// mistaken for an inference bottleneck.
async function injectAtRate(pool, rate, durationSeconds, label) {
  const intervalMs = 1000 / rate;
  let cursor = 0;
  let sent = 0;
  let failed = 0;
  const pending = [];
  const end = Date.now() + durationSeconds * 1000;

  console.log(`[${new Date().toISOString()}] ${label}: injecting at ${rate} evt/s for ${durationSeconds}s`);

  while (Date.now() < end) {
    const tickStart = Date.now();
    const event = nextFeatureEvent(pool, cursor);
    cursor += 1;
    pending.push(
      messaging.publish(TOPICS.FEATURES, event).then(
        () => { sent += 1; },
        () => { failed += 1; }
      )
    );
    const elapsed = Date.now() - tickStart;
    if (elapsed < intervalMs) await wait(intervalMs - elapsed);
  }

  await Promise.all(pending);
  console.log(`[${new Date().toISOString()}] ${label} done: sent ${sent}, failed ${failed}`);
  return { sent, failed };
}

async function main() {
  console.log(`MST probe. Candidate rates: ${rates.join(', ')} evt/s. Warmup ${warmupSeconds}s, measurement ${stageSeconds}s per rate.`);
  console.log(`Publishing directly to ${TOPICS.FEATURES} (${config.useSqs ? 'SQS' : 'MQTT'}). Make sure InferenceMaxTasks is pinned to 1 and watch-scaling.sh is running.\n`);

  await messaging.connect(`mst-probe-${process.pid}`);
  const pool = buildFeaturePool();

  for (const rate of rates) {
    await injectAtRate(pool, rate, warmupSeconds, `${rate} evt/s warmup`);
    const result = await injectAtRate(pool, rate, stageSeconds, `${rate} evt/s measurement`);
    if (result.failed > 0) {
      console.warn(`  warning: ${result.failed} publish failures at ${rate} evt/s, treat this rate's result as unreliable`);
    }
    console.log('  check the queue depth CSV for this window: flat = sustainable, still climbing = past MST\n');
    await wait(5000); // brief cooldown between rates, mirrors StreamBed's cooldown phase
  }

  console.log('Probe complete. The MST is the highest rate above whose measurement window queue depth stayed flat rather than climbing.');
  process.exit(0);
}

main().catch((err) => {
  console.error('mst-probe failed:', err);
  process.exit(1);
});
