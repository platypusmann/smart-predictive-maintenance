'use strict';

// End to end smoke test. Starts the broker and the 3 services on separate
// ports, sends a faulty machine through, and checks a work order comes out.
// Needs MongoDB running locally (docker compose up -d mongo).
//
// Usage: npm run smoke

const { spawn } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
const { featureNames } = require('@pdm/shared');

const ROOT = path.resolve(__dirname, '..');
const API_KEY = 'smoke-test-key';
// separate database so the test doesn't touch real data
const MONGO_URI = process.env.SMOKE_MONGO_URI || 'mongodb://localhost:27017/pdm_smoke';

const ENV = {
  ...process.env,
  MONGO_URI,
  USE_SQS: 'false',
  MQTT_URL: 'mqtt://localhost:1884',
  BROKER_PORT: '1884',
  INGESTION_PORT: '3101',
  INFERENCE_PORT: '3102',
  ALERTING_PORT: '3103',
  API_KEY,
};

const children = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start(file) {
  const child = spawn('node', [path.join(ROOT, file)], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  // only show errors from the services
  child.stderr.on('data', (data) => {
    if (data.toString().includes('ERROR')) process.stderr.write(data);
  });
  children.push(child);
}

function stopAll() {
  for (const child of children) child.kill();
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  return response.json();
}

function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// keep trying fn() until it returns something truthy
async function waitFor(what, fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      // not ready yet
    }
    await wait(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} (${detail})`);
  if (ok) passed += 1;
  else failed += 1;
}

// feature vector from a few named values, everything else is 0
function vector(values) {
  const names = featureNames();
  const result = new Array(names.length).fill(0);
  for (const [name, value] of Object.entries(values)) result[names.indexOf(name)] = value;
  return result;
}

const FAULTY = vector({
  vibration_mean: 6.6, vibration_std: 0.14, vibration_min: 6.3, vibration_max: 6.9, vibration_slope: 0.01,
  temperature_mean: 76, temperature_std: 0.5, temperature_min: 75, temperature_max: 77.5,
  current_mean: 18, current_std: 0.25, current_min: 17.5, current_max: 18.4,
  rpm_mean: 1280, rpm_std: 6, rpm_min: 1270, rpm_max: 1290,
  runtime_hours: 8.5,
});

const HEALTHY = vector({
  vibration_mean: 2.5, vibration_std: 0.12, vibration_min: 2.35, vibration_max: 2.65,
  temperature_mean: 55, temperature_std: 0.45, temperature_min: 54.4, temperature_max: 55.7,
  current_mean: 12, current_std: 0.25, current_min: 11.7, current_max: 12.3,
  rpm_mean: 1450, rpm_std: 6, rpm_min: 1442, rpm_max: 1458,
  runtime_hours: 1.2,
});

async function main() {
  // start from an empty database
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch (err) {
    throw new Error(`can't connect to MongoDB at ${MONGO_URI} (try: docker compose up -d mongo)`);
  }

  console.log('Starting services...\n');
  start('services/broker/src/server.js');
  await wait(1000);
  start('services/ingestion/src/server.js');
  start('services/inference/src/server.js');
  start('services/alerting/src/server.js');

  await waitFor('services to start', async () => {
    const results = await Promise.all(
      [3101, 3102, 3103].map((port) => getJson(`http://localhost:${port}/health`))
    );
    return results.every((r) => r.status === 'ok');
  }, 60000);
  check('all three services are up', true, 'health ok');

  const readingsUrl = 'http://localhost:3101/api/v1/readings';

  const noKey = await post(readingsUrl, { readings: [] });
  check('request without API key is rejected', noKey.status === 401, `HTTP ${noKey.status}`);

  const bad = await post(readingsUrl, { readings: [{ machineId: 'X', features: [1, 2, 3] }] }, { 'x-api-key': API_KEY });
  check('bad feature vector is rejected', bad.status === 400, `HTTP ${bad.status}`);

  const scoreUrl = 'http://localhost:3102/api/v1/score';
  const faulty = await (await post(scoreUrl, { features: FAULTY })).json();
  check('faulty machine scores above 0.7', faulty.riskScore >= 0.7, `risk ${faulty.riskScore.toFixed(3)}`);

  const healthy = await (await post(scoreUrl, { features: HEALTHY })).json();
  check('healthy machine scores below 0.7', healthy.riskScore < 0.7, `risk ${healthy.riskScore.toFixed(3)}`);

  // send 6 faulty windows so alerting sees at least 3 in a row
  for (let i = 0; i < 6; i += 1) {
    await post(readingsUrl, {
      readings: [{
        machineId: 'SMOKE-0001',
        machineType: 'pump',
        timestamp: new Date().toISOString(),
        runtimeHours: 8.5,
        features: FAULTY,
      }],
    }, { 'x-api-key': API_KEY });
    await wait(250);
  }

  const metrics = await waitFor('inference to score the windows', async () => {
    const m = await getJson('http://localhost:3102/metrics');
    return m.counters.predictions_scored >= 6 && m;
  });
  check('inference scored every window', true, `${metrics.counters.predictions_scored} scored`);

  const workOrders = await waitFor('a work order', async () => {
    const data = await getJson('http://localhost:3103/api/v1/work-orders');
    return data.workOrders.length > 0 && data.workOrders;
  });
  check('alerting raised a work order', workOrders[0].machineId === 'SMOKE-0001', `machine ${workOrders[0].machineId}`);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    stopAll();
    process.exit(code);
  })
  .catch((err) => {
    console.error(`\nSmoke test failed: ${err.message}`);
    stopAll();
    process.exit(1);
  });
