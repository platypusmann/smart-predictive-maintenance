'use strict';

// Ingestion service
// Node-RED posts batches of feature vectors here. They get saved to Mongo and
// published as events for the inference service to pick up.

const express = require('express');
const mongoose = require('mongoose');
const {
  loadConfig,
  createLogger,
  featureNames,
  Metrics,
  TOPICS,
  messaging,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('ingestion');
const metrics = new Metrics();
const FEATURE_COUNT = featureNames().length;

const Reading = mongoose.model('Reading', new mongoose.Schema({
  machineId: { type: String, required: true, index: true },
  machineType: String,
  timestamp: Date,
  runtimeHours: Number,
  vibration: Number,
  temperature: Number,
  current: Number,
  rpm: Number,
  features: [Number],
}));

// returns an error message, or null if the batch looks ok
function validateBatch(body) {
  if (!body || !Array.isArray(body.readings)) {
    return 'body.readings must be an array';
  }
  if (body.readings.length === 0 || body.readings.length > 500) {
    return 'body.readings must contain 1 to 500 items';
  }
  for (const [i, item] of body.readings.entries()) {
    if (typeof item.machineId !== 'string' || !item.machineId) {
      return `readings[${i}].machineId is required`;
    }
    if (!Array.isArray(item.features) || item.features.length !== FEATURE_COUNT) {
      return `readings[${i}].features must have ${FEATURE_COUNT} values`;
    }
    if (!item.features.every((value) => Number.isFinite(value))) {
      return `readings[${i}].features must all be numbers`;
    }
  }
  return null;
}

async function main() {
  await mongoose.connect(config.mongoUri);
  await messaging.connect(`ingestion-${process.pid}`);

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ingestion' });
  });

  app.get('/metrics', (req, res) => {
    res.json({ service: 'ingestion', ...metrics.snapshot() });
  });

  app.post('/api/v1/readings', async (req, res) => {
    if (req.get('x-api-key') !== config.apiKey) {
      return res.status(401).json({ error: 'invalid or missing API key' });
    }

    const error = validateBatch(req.body);
    if (error) {
      metrics.increment('requests_rejected');
      return res.status(400).json({ error });
    }

    const start = Date.now();
    const { readings } = req.body;
    try {
      await Reading.insertMany(readings.map((item) => ({
        machineId: item.machineId,
        machineType: item.machineType,
        timestamp: item.timestamp || new Date(),
        runtimeHours: item.runtimeHours,
        vibration: item.raw?.vibration,
        temperature: item.raw?.temperature,
        current: item.raw?.current,
        rpm: item.raw?.rpm,
        features: item.features,
      })));

      await Promise.all(readings.map((item) => messaging.publish(TOPICS.FEATURES, {
        machineId: item.machineId,
        machineType: item.machineType,
        timestamp: item.timestamp || new Date().toISOString(),
        features: item.features,
      })));

      metrics.increment('readings_accepted', readings.length);
      metrics.observeLatency(Date.now() - start);
      return res.status(202).json({ accepted: readings.length });
    } catch (err) {
      metrics.increment('requests_failed');
      log.error('failed to save batch', { error: err.message });
      return res.status(503).json({ error: 'could not save readings' });
    }
  });

  app.listen(config.ingestionPort, () => {
    log.info(`listening on port ${config.ingestionPort}`);
  });
}

main().catch((err) => {
  log.error('failed to start', { error: err.message });
  process.exit(1);
});
