'use strict';

/**
 * Inference microservice.
 *
 * Consumes feature events, scores them with the exported random forest, stores
 * the prediction, and republishes anything above the risk threshold for the
 * alerting service. The process is stateless: it holds no per-machine memory
 * between messages, which is precisely what allows the AWS Auto Scaling Group
 * to add and remove tasks freely while the queue absorbs the difference.
 *
 * This is the service the scaling experiment targets, because model scoring is
 * the most CPU-intensive step in the pipeline.
 */

const path = require('path');
const express = require('express');
const {
  loadConfig,
  createLogger,
  createStore,
  createEventBus,
  RandomForest,
  Metrics,
  TOPICS,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('inference', config.logLevel);
const metrics = new Metrics();

const modelPath =
  config.modelPath ||
  path.resolve(__dirname, '../../../ml/artifacts/model.json');

/** Optional artificial work per message, used to make scaling observable. */
const cpuBurnMs = Number(process.env.CPU_BURN_MS || 0);
function burnCpu(ms) {
  if (ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy loop. Only ever enabled deliberately during load tests, so a modest
    // number of simulated machines can saturate a task and trigger a scale-out
    // without needing a fleet of thousands.
    Math.sqrt(Math.random());
  }
}

async function main() {
  let forest;
  try {
    forest = RandomForest.fromFile(modelPath);
  } catch (err) {
    log.error('could not load model', { modelPath, error: err.message });
    log.error('run "npm run ml:all" first to generate ml/artifacts/model.json');
    process.exit(1);
  }

  log.info('model loaded', {
    modelPath,
    modelVersion: forest.modelVersion,
    trees: forest.trees.length,
    features: forest.featureNames.length,
    rocAuc: forest.metadata.rocAuc,
  });

  const store = await createStore(config).connect();
  const bus = await createEventBus({
    clientId: `inference-${process.pid}`,
    config,
  }).connect();

  await bus.subscribe(TOPICS.FEATURES, async (event) => {
    const startedAt = process.hrtime.bigint();
    try {
      const result = forest.score(event.features, config.riskThreshold);
      burnCpu(cpuBurnMs);

      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      await store.savePrediction({
        machineId: event.machineId,
        timestamp: new Date(event.timestamp || Date.now()),
        riskScore: result.riskScore,
        predictedFailing: result.predictedFailing,
        modelVersion: result.modelVersion,
        inferenceLatencyMs: latencyMs,
      });

      if (result.predictedFailing) {
        await bus.publish(TOPICS.HIGH_RISK, {
          machineId: event.machineId,
          machineType: event.machineType,
          timestamp: event.timestamp,
          riskScore: result.riskScore,
          modelVersion: result.modelVersion,
        });
        metrics.increment('high_risk_published');
      }

      metrics.increment('predictions_scored');
      metrics.observeLatency(latencyMs);

      if (event.emittedAt) {
        // End-to-end lag from ingestion accepting the reading to it being
        // scored. This is the number reported as pipeline latency.
        metrics.observeLatency(Date.now() - event.emittedAt);
      }
    } catch (err) {
      metrics.increment('predictions_failed');
      log.error('failed to score event', {
        machineId: event?.machineId,
        error: err.message,
      });
      throw err; // leave the message on the queue for redelivery
    }
  });

  log.info('subscribed to feature events', {
    topic: TOPICS.FEATURES,
    bus: bus.driver,
    store: store.driver,
    riskThreshold: config.riskThreshold,
    cpuBurnMs,
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'inference',
      modelVersion: forest.modelVersion,
      trees: forest.trees.length,
    });
  });

  app.get('/metrics', (req, res) => {
    res.json({ service: 'inference', modelVersion: forest.modelVersion, ...metrics.snapshot() });
  });

  // Synchronous scoring endpoint. Not on the main data path, but useful for
  // smoke testing a deployed task and for the dashboard's what-if control.
  app.post('/api/v1/score', express.json(), (req, res) => {
    try {
      const result = forest.score(req.body?.features, config.riskThreshold);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  const server = app.listen(config.inferencePort, () => {
    log.info('inference listening', { port: config.inferencePort });
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
  log.error('inference failed to start', { error: err.message });
  process.exit(1);
});
