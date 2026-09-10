'use strict';

// Load test - sends feature vectors from simulated machines straight to the
// ingestion API, with more machines in each stage.
//
// Usage: npm run loadtest -- --stages 10,50,100 --stage-seconds 60
// Set INGESTION_URL to point it at the AWS load balancer instead of localhost.

const { RollingWindow } = require('@pdm/shared');
const { SimulatedMachine, MACHINE_TYPES } = require('../../services/simulator/src/machine');

const INGESTION_URL = process.env.INGESTION_URL || 'http://localhost:3001';
const API_KEY = process.env.API_KEY || 'local-dev-key';

let stages = [10, 50, 100];
let stageSeconds = 60;
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] === '--stages') stages = process.argv[i + 1].split(',').map(Number);
  if (process.argv[i] === '--stage-seconds') stageSeconds = Number(process.argv[i + 1]);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendBatch(readings, stats) {
  const start = Date.now();
  try {
    const response = await fetch(`${INGESTION_URL}/api/v1/readings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ readings }),
    });
    if (response.ok) stats.accepted += readings.length;
    else stats.failed += readings.length;
  } catch (err) {
    stats.failed += readings.length;
  }
  stats.requests += 1;
  stats.totalMs += Date.now() - start;
}

async function runStage(machineCount) {
  const types = Object.keys(MACHINE_TYPES);
  const fleet = [];
  for (let i = 0; i < machineCount; i += 1) {
    const machine = new SimulatedMachine({
      id: `LT-${i + 1}`,
      type: types[i % types.length],
      seed: 1000 + i,
      timeScale: 600,
    });
    const window = new RollingWindow({ stride: 1 });
    for (let j = 0; j < 30; j += 1) window.push(machine.tick(1)); // fill the window first
    fleet.push({ machine, window });
  }

  const stats = { sent: 0, accepted: 0, failed: 0, requests: 0, totalMs: 0 };
  const requests = [];

  // every second each machine makes one feature vector, sent in batches of 50
  const timer = setInterval(() => {
    let batch = [];
    for (const { machine, window } of fleet) {
      const emitted = window.push(machine.tick(1));
      if (!emitted) continue;
      batch.push({
        machineId: machine.id,
        machineType: machine.type,
        runtimeHours: machine.simSeconds / 3600,
        features: emitted.features,
      });
      stats.sent += 1;
      if (batch.length === 50) {
        requests.push(sendBatch(batch, stats));
        batch = [];
      }
    }
    if (batch.length > 0) requests.push(sendBatch(batch, stats));
  }, 1000);

  await wait(stageSeconds * 1000);
  clearInterval(timer);
  await Promise.all(requests);

  const avgMs = stats.requests ? Math.round(stats.totalMs / stats.requests) : 0;
  console.log(
    `${machineCount} machines: sent ${stats.sent}, accepted ${stats.accepted}, failed ${stats.failed}, ` +
    `${(stats.accepted / stageSeconds).toFixed(1)} per sec, avg request ${avgMs}ms`
  );
}

async function main() {
  console.log(`Load testing ${INGESTION_URL}, stages: ${stages.join(', ')} machines, ${stageSeconds}s each\n`);
  for (const machineCount of stages) {
    await runStage(machineCount);
  }
}

main();
