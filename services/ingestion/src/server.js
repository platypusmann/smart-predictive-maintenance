'use strict';

/**
 * Ingestion microservice.
 *
 * Receives feature vectors from the Node-RED edge flow over HTTPS, validates
 * them, persists them, and publishes a feature event onto the bus. It does not
 * call the inference service directly: putting a queue between the two is what
 * lets inference scale independently and what stops a burst of sensor traffic
 * from overwhelming the model, which is the core scalability argument of the
 * project.
 */

const express = require('express');
const {
  loadConfig,
  createLogger,
  createStore,
  createEventBus,
  featureNames,
  Metrics,
  TOPICS,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('ingestion', config.logLevel);
const metrics = new Metrics();
const EXPECTED_FEATURES = featureNames().length;

/** Reject unauthenticated callers before any work is done. */
function apiKeyAuth(req, res, next) {
  if (!config.requireApiKey) return next();
  const provided = req.get('x-api-key');
  if (!provided || provided !== config.apiKey) {
    metrics.increment('requests_unauthorized');
    return res.status(401).json({ error: 'invalid or missing API key' });
  }
  return next();
}

/** Shape validation. Anything malformed is rejected at the edge of the system. */
function validateBatch(body) {
  if (!body || !Array.isArray(body.readings)) {
    return { ok: false, error: 'body.readings must be an array' };
  }
  if (body.readings.length === 0 || body.readings.length > 500) {
    return { ok: false, error: 'body.readings must contain 1 to 500 items' };
  }

  for (const [index, item] of body.readings.entries()) {
    if (typeof item.machineId !== 'string' || item.machineId.length === 0) {
      return { ok: false, error: `readings[${index}].machineId is required` };
    }
    if (!Array.isArray(item.features) || item.features.length !== EXPECTED_FEATURES) {
      return {
        ok: false,
        error: `readings[${index}].features must have ${EXPECTED_FEATURES} values`,
      };
    }
    if (!item.features.every((value) => Number.isFinite(value))) {
      return { ok: false, error: `readings[${index}].features must all be finite` };
    }
  }
  return { ok: true };
}

async function main() {
  const store = await createStore(config).connect();
  const bus = await createEventBus({
    clientId: `ingestion-${process.pid}`,
    config,
  }).connect();

  log.info('dependencies ready', {
    store: store.driver,
    bus: bus.driver,
    expectedFeatures: EXPECTED_FEATURES,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Unauthenticated so the AWS load balancer and ECS health checks can reach it.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ingestion', store: store.driver, bus: bus.driver });
  });

  app.get('/metrics', (req, res) => {
    res.json({ service: 'ingestion', ...metrics.snapshot() });
  });

  app.post('/api/v1/readings', apiKeyAuth, async (req, res) => {
    const startedAt = process.hrtime.bigint();

    const validation = validateBatch(req.body);
    if (!validation.ok) {
      metrics.increment('requests_rejected');
      return res.status(400).json({ error: validation.error });
    }

    const { readings } = req.body;
    try {
      const documents = readings.map((item) => ({
        machineId: item.machineId,
        machineType: item.machineType,
        timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
        runtimeHours: item.runtimeHours,
        vibration: item.raw?.vibration,
        temperature: item.raw?.temperature,
        current: item.raw?.current,
        rpm: item.raw?.rpm,
        features: item.features,
      }));

      await store.saveReadings(documents);

      // Publish after the write succeeds, so an event never references a
      // reading that was not persisted.
      await Promise.all(
        readings.map((item) =>
          bus.publish(TOPICS.FEATURES, {
            machineId: item.machineId,
            machineType: item.machineType,
            timestamp: item.timestamp || new Date().toISOString(),
            features: item.features,
            emittedAt: Date.now(),
          })
        )
      );

      metrics.increment('readings_accepted', readings.length);
      metrics.increment('events_published', readings.length);
      metrics.observeLatency(Number(process.hrtime.bigint() - startedAt) / 1e6);

      return res.status(202).json({ accepted: readings.length });
    } catch (err) {
      metrics.increment('requests_failed');
      log.error('failed to ingest batch', { error: err.message });
      return res.status(503).json({ error: 'ingestion temporarily unavailable' });
    }
  });

  const server = app.listen(config.ingestionPort, () => {
    log.info('ingestion listening', { port: config.ingestionPort });
  });

  const shutdown = async (signal) => {
    log.info('shutting down', { signal, ...metrics.snapshot() });
    server.close(async () => {
      await bus.close();
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('ingestion failed to start', { error: err.message });
  process.exit(1);
});
