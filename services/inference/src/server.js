'use strict';

// Inference service
// Listens for feature events, scores them with the random forest and saves the
// prediction. Anything over the risk threshold is passed on to alerting.
// This is the service that auto scales on AWS.

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const {
  loadConfig,
  createLogger,
  RandomForest,
  Metrics,
  TOPICS,
  messaging,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('inference');
const metrics = new Metrics();

const modelPath = config.modelPath || path.resolve(__dirname, '../../../ml/artifacts/model.json');

// extra fake work per message, makes it easier to trigger scaling in the demo
const CPU_BURN_MS = Number(process.env.CPU_BURN_MS || 0);

const Prediction = mongoose.model('Prediction', new mongoose.Schema({
  machineId: { type: String, required: true, index: true },
  timestamp: Date,
  riskScore: Number,
  predictedFailing: Boolean,
  modelVersion: String,
  inferenceLatencyMs: Number,
}));

function burnCpu(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) Math.sqrt(Math.random());
}

async function main() {
  let forest;
  try {
    forest = RandomForest.fromFile(modelPath);
  } catch (err) {
    log.error(`could not load model from ${modelPath}, run "npm run ml:all" first`, { error: err.message });
    process.exit(1);
  }
  log.info('model loaded', { version: forest.modelVersion, trees: forest.trees.length });

  await mongoose.connect(config.mongoUri);
  await messaging.connect(`inference-${process.pid}`);

  await messaging.subscribe(TOPICS.FEATURES, async (event) => {
    const start = process.hrtime.bigint();
    const result = forest.score(event.features, config.riskThreshold);
    if (CPU_BURN_MS > 0) burnCpu(CPU_BURN_MS);
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;

    await Prediction.create({
      machineId: event.machineId,
      timestamp: event.timestamp || new Date(),
      riskScore: result.riskScore,
      predictedFailing: result.predictedFailing,
      modelVersion: result.modelVersion,
      inferenceLatencyMs: latencyMs,
    });

    if (result.predictedFailing) {
      await messaging.publish(TOPICS.HIGH_RISK, {
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
  });

  const app = express();

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'inference', modelVersion: forest.modelVersion });
  });

  app.get('/metrics', (req, res) => {
    res.json({ service: 'inference', ...metrics.snapshot() });
  });

  // score a single feature vector directly (handy for testing)
  app.post('/api/v1/score', express.json(), (req, res) => {
    try {
      res.json(forest.score(req.body?.features, config.riskThreshold));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.listen(config.inferencePort, () => {
    log.info(`listening on port ${config.inferencePort}`);
  });
}

main().catch((err) => {
  log.error('failed to start', { error: err.message });
  process.exit(1);
});
