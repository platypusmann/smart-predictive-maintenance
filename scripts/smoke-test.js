'use strict';

/**
 * End-to-end smoke test.
 *
 * Boots the full stack in-process, drives a deliberately faulted machine
 * through it, and asserts that the pipeline produces predictions and finally a
 * work order. This is the check that the pieces are actually wired together,
 * as opposed to the unit tests which only prove each piece works alone.
 *
 * Usage: npm run smoke
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API_KEY = 'smoke-test-key';

const ENV = {
  ...process.env,
  STORE_DRIVER: 'memory',
  EVENT_BUS_DRIVER: 'mqtt',
  MQTT_URL: 'mqtt://localhost:1884',
  BROKER_PORT: '1884',
  INGESTION_PORT: '3101',
  INFERENCE_PORT: '3102',
  ALERTING_PORT: '3103',
  INGESTION_URL: 'http://localhost:3101',
  API_KEY,
  RISK_THRESHOLD: '0.7',
  CONSECUTIVE_BREACHES: '3',
  LOG_LEVEL: 'warn',
};

const children = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start(name, file) {
  const child = spawn('node', [path.join(ROOT, file)], {
    cwd: ROOT,
    env: ENV,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('"level":"error"')) process.stderr.write(`[${name}] ${text}`);
  });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) child.kill('SIGKILL');
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

/** Wait for a condition, polling until the timeout expires. */
async function until(description, predicate, timeoutMs = 20000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${description} (last saw: ${JSON.stringify(last)})`);
}

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
}

async function main() {
  console.log('Smoke test: booting stack on isolated ports...\n');

  start('broker', 'services/broker/src/server.js');
  await wait(900);
  start('ingestion', 'services/ingestion/src/server.js');
  start('inference', 'services/inference/src/server.js');
  start('alerting', 'services/alerting/src/server.js');
  await wait(2500);

  // 1. Health
  const health = await until('all services healthy', async () => {
    const [ing, inf, alt] = await Promise.all([
      getJson('http://localhost:3101/health'),
      getJson('http://localhost:3102/health'),
      getJson('http://localhost:3103/health'),
    ]);
    return ing.status === 'ok' && inf.status === 'ok' && alt.status === 'ok'
      ? { ing, inf, alt }
      : null;
  });
  check('all three services report healthy', true, `model ${health.inf.modelVersion}`);

  // 2. Authentication is enforced
  const unauth = await fetch('http://localhost:3101/api/v1/readings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ readings: [] }),
  });
  check('unauthenticated request is rejected', unauth.status === 401, `HTTP ${unauth.status}`);

  // 3. Malformed payloads are rejected
  const malformed = await fetch('http://localhost:3101/api/v1/readings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ readings: [{ machineId: 'X', features: [1, 2, 3] }] }),
  });
  check('malformed feature vector is rejected', malformed.status === 400, `HTTP ${malformed.status}`);

  // 4. Drive a clearly faulted machine through the pipeline.
  const { featureNames } = require('@pdm/shared');
  const names = featureNames();
  const faulted = () => {
    const vector = new Array(names.length).fill(0);
    const set = (name, value) => { vector[names.indexOf(name)] = value; };
    // Severely degraded pump: high vibration and temperature, sagging RPM.
    set('vibration_mean', 6.6); set('vibration_min', 6.3); set('vibration_max', 6.9);
    set('vibration_std', 0.14); set('vibration_slope', 0.01);
    set('temperature_mean', 76); set('temperature_min', 75); set('temperature_max', 77.5);
    set('temperature_std', 0.5);
    set('current_mean', 18); set('current_min', 17.5); set('current_max', 18.4);
    set('current_std', 0.25);
    set('rpm_mean', 1280); set('rpm_min', 1270); set('rpm_max', 1290); set('rpm_std', 6);
    set('runtime_hours', 8.5);
    return vector;
  };

  const score = await (
    await fetch('http://localhost:3102/api/v1/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: faulted() }),
    })
  ).json();
  check(
    'faulted machine scores above the risk threshold',
    score.riskScore >= 0.7,
    `risk ${score.riskScore.toFixed(3)}`
  );

  // Send enough windows to satisfy the confirmation streak.
  for (let i = 0; i < 6; i += 1) {
    await fetch('http://localhost:3101/api/v1/readings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        readings: [{
          machineId: 'SMOKE-0001',
          machineType: 'pump',
          timestamp: new Date().toISOString(),
          runtimeHours: 8.5,
          features: faulted(),
        }],
      }),
    });
    await wait(250);
  }

  const scored = await until('inference to score the events', async () => {
    const metrics = await getJson('http://localhost:3102/metrics');
    return (metrics.counters?.predictions_scored || 0) >= 6 ? metrics : null;
  });
  check(
    'inference scored every ingested window',
    true,
    `${scored.counters.predictions_scored} scored, p95 ${scored.latencyMs.p95}ms`
  );

  const workOrders = await until('a work order to be raised', async () => {
    const data = await getJson('http://localhost:3103/api/v1/work-orders');
    return data.workOrders.length > 0 ? data.workOrders : null;
  });
  check(
    'alerting raised a work order for the faulted machine',
    workOrders[0].machineId === 'SMOKE-0001',
    `risk ${Number(workOrders[0].riskScore).toFixed(3)}`
  );

  // 5. A healthy machine must not generate a work order.
  const healthy = new Array(names.length).fill(0);
  const setH = (name, value) => { healthy[names.indexOf(name)] = value; };
  setH('vibration_mean', 2.5); setH('vibration_min', 2.35); setH('vibration_max', 2.65);
  setH('vibration_std', 0.12);
  setH('temperature_mean', 55); setH('temperature_min', 54.4); setH('temperature_max', 55.7);
  setH('temperature_std', 0.45);
  setH('current_mean', 12); setH('current_min', 11.7); setH('current_max', 12.3);
  setH('current_std', 0.25);
  setH('rpm_mean', 1450); setH('rpm_min', 1442); setH('rpm_max', 1458); setH('rpm_std', 6);
  setH('runtime_hours', 1.2);

  const healthyScore = await (
    await fetch('http://localhost:3102/api/v1/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: healthy }),
    })
  ).json();
  check(
    'healthy machine scores below the risk threshold',
    healthyScore.riskScore < 0.7,
    `risk ${healthyScore.riskScore.toFixed(3)}`
  );

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => { stopAll(); process.exit(code); })
  .catch((err) => {
    console.error(`\nSmoke test failed: ${err.message}`);
    stopAll();
    process.exit(1);
  });
