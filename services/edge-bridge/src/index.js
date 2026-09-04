'use strict';

/**
 * Headless edge processor.
 *
 * This is a functional equivalent of node-red/flows.json: it subscribes to raw
 * sensor readings, maintains a rolling window per machine, and posts feature
 * vectors to the ingestion API. Both paths share the exact same windowing code
 * from @pdm/shared, so they cannot drift apart.
 *
 * Node-RED remains the primary edge implementation and is what the project
 * demonstrates. This bridge exists because Node-RED's own runtime becomes the
 * bottleneck well before the microservices do, which would make a load test
 * measure Node-RED rather than the thing being scaled.
 *
 * Usage:
 *   node src/index.js --batch-size 25 --flush-ms 1000
 */

const mqtt = require('mqtt');
const {
  loadConfig,
  createLogger,
  RollingWindow,
  Metrics,
  TOPICS,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('edge-bridge', config.logLevel);
const metrics = new Metrics();

function parseArgs(argv) {
  const args = { batchSize: 25, flushMs: 1000, stride: 10 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'batch-size') args.batchSize = Number(value);
    if (key === 'flush-ms') args.flushMs = Number(value);
    if (key === 'stride') args.stride = Number(value);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const windows = new Map(); // machineId -> RollingWindow
  let pending = [];

  const client = mqtt.connect(config.mqttUrl, {
    clientId: `edge-bridge-${process.pid}`,
    reconnectPeriod: 2000,
  });

  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });

  await new Promise((resolve, reject) => {
    client.subscribe(`${TOPICS.RAW_READINGS}/+`, { qos: 0 }, (err) =>
      err ? reject(err) : resolve()
    );
  });

  log.info('edge bridge started', {
    broker: config.mqttUrl,
    ingestion: config.ingestionUrl,
    batchSize: args.batchSize,
    flushMs: args.flushMs,
  });

  /** POST the accumulated feature vectors as one batch. */
  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];

    const startedAt = Date.now();
    try {
      const response = await fetch(`${config.ingestionUrl}/api/v1/readings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
        },
        body: JSON.stringify({ readings: batch }),
      });

      if (!response.ok) {
        metrics.increment('batches_rejected');
        log.warn('ingestion rejected batch', {
          status: response.status,
          size: batch.length,
        });
        return;
      }

      metrics.increment('batches_sent');
      metrics.increment('vectors_sent', batch.length);
      metrics.observeLatency(Date.now() - startedAt);
    } catch (err) {
      metrics.increment('batches_failed');
      log.error('failed to reach ingestion', { error: err.message });
    }
  }

  client.on('message', (topic, payload) => {
    let reading;
    try {
      reading = JSON.parse(payload.toString());
    } catch (err) {
      metrics.increment('malformed_readings');
      return;
    }

    if (!windows.has(reading.machineId)) {
      windows.set(reading.machineId, new RollingWindow({ stride: args.stride }));
    }

    const emitted = windows.get(reading.machineId).push(reading);
    if (!emitted) return;

    metrics.increment('windows_emitted');
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

  // Time-based flush so a small fleet still delivers promptly.
  const timer = setInterval(flush, args.flushMs);
  const reporter = setInterval(() => {
    log.info('edge throughput', {
      trackedMachines: windows.size,
      ...metrics.snapshot().counters,
    });
  }, 15000);

  const shutdown = (signal) => {
    log.info('shutting down', { signal, ...metrics.snapshot() });
    clearInterval(timer);
    clearInterval(reporter);
    flush().finally(() => client.end(false, {}, () => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('edge bridge failed to start', { error: err.message });
  process.exit(1);
});
