'use strict';

// Starts the whole local stack with one command. MongoDB needs to be running
// first (docker compose up -d mongo).
//
//   node scripts/run-stack.js                  20 machines through the edge bridge
//   node scripts/run-stack.js --machines 100
//   node scripts/run-stack.js --node-red       don't start the edge bridge (use Node-RED)
//   node scripts/run-stack.js --no-simulator   for load testing
//   node scripts/run-stack.js --duration 180   run for 3 minutes then print a summary

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const args = { machines: 20, timeScale: 120, interval: 1000, duration: 0, simulator: true, edge: true };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--no-simulator') args.simulator = false;
  else if (arg === '--node-red') args.edge = false;
  else if (arg === '--machines') args.machines = Number(process.argv[++i]);
  else if (arg === '--time-scale') args.timeScale = Number(process.argv[++i]);
  else if (arg === '--interval') args.interval = Number(process.argv[++i]);
  else if (arg === '--duration') args.duration = Number(process.argv[++i]);
}

const children = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start(file, extraArgs = []) {
  children.push(spawn('node', [path.join(ROOT, file), ...extraArgs], { cwd: ROOT, stdio: 'inherit' }));
}

function stopAll() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', stopAll);

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (err) {
    return {};
  }
}

async function printSummary() {
  const ingestion = await fetchJson('http://localhost:3001/metrics');
  const inference = await fetchJson('http://localhost:3002/metrics');
  const alerting = await fetchJson('http://localhost:3003/metrics');

  console.log('\n----- summary -----');
  console.log('readings accepted: ', ingestion.counters?.readings_accepted ?? 0);
  console.log('predictions scored:', inference.counters?.predictions_scored ?? 0);
  console.log('high risk events:  ', inference.counters?.high_risk_published ?? 0);
  console.log('work orders raised:', alerting.counters?.work_orders_created ?? 0);
  console.log('inference p95 (ms):', inference.latencyMs?.p95 ?? 0);
}

async function main() {
  start('services/broker/src/server.js');
  await wait(1000); // give the broker a second before everything connects

  start('services/ingestion/src/server.js');
  start('services/inference/src/server.js');
  start('services/alerting/src/server.js');
  start('services/dashboard/src/server.js');
  await wait(1500);

  if (args.edge) start('services/edge-bridge/src/index.js');
  if (args.simulator) {
    start('services/simulator/src/index.js', [
      '--machines', String(args.machines),
      '--time-scale', String(args.timeScale),
      '--interval', String(args.interval),
    ]);
  }

  console.log('\nStack running, dashboard at http://localhost:3000 (Ctrl+C to stop)\n');

  if (args.duration > 0) {
    await wait(args.duration * 1000);
    await printSummary();
    stopAll();
  }
}

main();
