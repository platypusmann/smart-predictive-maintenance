'use strict';

// Alerting service
// Listens for high risk events and raises a work order once AlertPolicy says
// the machine has been high risk for long enough.

const express = require('express');
const mongoose = require('mongoose');
const {
  loadConfig,
  createLogger,
  AlertPolicy,
  Metrics,
  TOPICS,
  messaging,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('alerting');
const metrics = new Metrics();

const WorkOrder = mongoose.model('WorkOrder', new mongoose.Schema({
  machineId: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  riskScore: Number,
  consecutiveBreaches: Number,
  status: { type: String, enum: ['open', 'acknowledged', 'closed'], default: 'open' },
  assignedTechnician: String,
  notes: String,
}));

async function main() {
  await mongoose.connect(config.mongoUri);
  await messaging.connect(`alerting-${process.pid}`);

  const policy = new AlertPolicy({
    threshold: config.riskThreshold,
    consecutiveBreaches: config.consecutiveBreaches,
    cooldownMs: config.alertCooldownMs,
  });

  await messaging.subscribe(TOPICS.HIGH_RISK, async (event) => {
    const decision = policy.evaluate(event.machineId, event.riskScore);
    metrics.increment(`decision_${decision.action}`);
    if (decision.action !== 'raise') return;

    const workOrder = await WorkOrder.create({
      machineId: event.machineId,
      riskScore: event.riskScore,
      consecutiveBreaches: decision.streak,
      notes: `Raised automatically: risk ${event.riskScore.toFixed(3)} for ` +
        `${decision.streak} windows in a row (model ${event.modelVersion})`,
    });

    metrics.increment('work_orders_created');
    log.warn('work order raised', {
      id: String(workOrder._id),
      machineId: event.machineId,
      riskScore: Number(event.riskScore.toFixed(3)),
    });
  });

  const app = express();

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'alerting' });
  });

  app.get('/metrics', (req, res) => {
    res.json({ service: 'alerting', trackedMachines: policy.trackedMachines(), ...metrics.snapshot() });
  });

  app.get('/api/v1/work-orders', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const workOrders = await WorkOrder.find({ status: 'open' })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      res.json({ workOrders });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(config.alertingPort, () => {
    log.info(`listening on port ${config.alertingPort}`);
  });
}

main().catch((err) => {
  log.error('failed to start', { error: err.message });
  process.exit(1);
});
