'use strict';

// Edge bridge - does the same job as the Node-RED flow (rolling window ->
// features -> POST to ingestion) but as a plain Node script. Used for load
// testing since Node-RED can't keep up with a big fleet.
//
// Usage: node src/index.js --batch-size 25 --flush-ms 1000

const mqtt = require('mqtt');
const {
  loadConfig,
  createLogger,
  RollingWindow,
  Metrics,
  TOPICS,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('edge-bridge');
const metrics = new Metrics();

function parseArgs(argv) {
  const args = { batchSize: 25, flushMs: 1000, stride: 10 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = Number(argv[i + 1]);
    if (key === 'batch-size') args.batchSize = value;
    if (key === 'flush-ms') args.flushMs = value;
    if (key === 'stride') args.stride = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const windows = new Map(); // machineId -> RollingWindow
  let pending = [];

  const client = await mqtt.connectAsync(config.mqttUrl, { clientId: `edge-bridge-${process.pid}` });
  await client.subscribeAsync(`${TOPICS.RAW_READINGS}/+`);
  log.info('edge bridge started', { ingestion: config.ingestionUrl, batchSize: args.batchSize });

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];

    try {
      const response = await fetch(`${config.ingestionUrl}/api/v1/readings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
        body: JSON.stringify({ readings: batch }),
      });
      if (response.ok) {
        metrics.increment('vectors_sent', batch.length);
      } else {
        metrics.increment('batches_rejected');
        log.warn('ingestion rejected batch', { status: response.status });
      }
    } catch (err) {
      metrics.increment('batches_failed');
      log.error('could not reach ingestion', { error: err.message });
    }
  }

  client.on('message', (topic, payload) => {
    let reading;
    try {
      reading = JSON.parse(payload.toString());
    } catch (err) {
      return;
    }

    if (!windows.has(reading.machineId)) {
      windows.set(reading.machineId, new RollingWindow({ stride: args.stride }));
    }

    const emitted = windows.get(reading.machineId).push(reading);
    if (!emitted) return;

    pending.push({
      machineId: reading.machineId,
      machineType: reading.machineType,
      timestamp: emitted.windowEnd,
      runtimeHours: reading.runtimeHours,
      features: emitted.features,
      raw: {
        vibration: reading.vibration,
        temperature: reading.temperature,
        current: reading.current,
        rpm: reading.rpm,
      },
    });

    if (pending.length >= args.batchSize) flush();
  });

  // also send every flushMs so small fleets don't wait ages for a full batch
  setInterval(flush, args.flushMs);

  setInterval(() => {
    log.info('edge stats', { machines: windows.size, ...metrics.snapshot().counters });
  }, 15000);
}

main().catch((err) => {
  log.error('edge bridge failed to start', { error: err.message });
  process.exit(1);
});
