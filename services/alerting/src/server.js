'use strict';

/**
 * Alerting / work-order microservice.
 *
 * Consumes high-risk events and decides whether a maintenance work order is
 * warranted, using the confirmation-streak and cooldown rules in AlertPolicy.
 * Separating this from inference means the alerting rules can be changed and
 * redeployed without touching the model-serving path.
 */

const express = require('express');
const {
  loadConfig,
  createLogger,
  createStore,
  createEventBus,
  AlertPolicy,
  Metrics,
  TOPICS,
} = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('alerting', config.logLevel);
const metrics = new Metrics();

async function main() {
  const store = await createStore(config).connect();
  const bus = await createEventBus({
    clientId: `alerting-${process.pid}`,
    config,
  }).connect();

  const policy = new AlertPolicy({
    threshold: config.riskThreshold,
    consecutiveBreaches: config.consecutiveBreaches,
    cooldownMs: config.alertCooldownMs,
  });

  await bus.subscribe(TOPICS.HIGH_RISK, async (event) => {
    try {
      const decision = policy.evaluate(event.machineId, event.riskScore);
      metrics.increment(`decision_${decision.action}`);

      if (decision.action !== 'raise') return;

      const workOrder = await store.createWorkOrder({
        machineId: event.machineId,
        createdAt: new Date(),
        riskScore: event.riskScore,
        consecutiveBreaches: decision.streak,
        status: 'open',
        notes:
          `Automatically raised: model ${event.modelVersion} scored ` +
          `${event.riskScore.toFixed(3)} on ${decision.streak} consecutive windows.`,
      });

      metrics.increment('work_orders_created');
      log.warn('work order raised', {
        workOrderId: String(workOrder._id),
        machineId: event.machineId,
        riskScore: Number(event.riskScore.toFixed(3)),
      });
    } catch (err) {
      metrics.increment('decisions_failed');
      log.error('failed to process high-risk event', {
        machineId: event?.machineId,
        error: err.message,
      });
      throw err; // redelivered rather than silently dropped
    }
  });

  log.info('subscribed to high-risk events', {
    topic: TOPICS.HIGH_RISK,
    threshold: config.riskThreshold,
    consecutiveBreaches: config.consecutiveBreaches,
    cooldownMs: config.alertCooldownMs,
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'alerting', tracked: policy.trackedMachines() });
  });

  app.get('/metrics', (req, res) => {
    res.json({
      service: 'alerting',
      trackedMachines: policy.trackedMachines(),
      ...metrics.snapshot(),
    });
  });

  app.get('/api/v1/work-orders', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ workOrders: await store.openWorkOrders(limit) });
  });

  const server = app.listen(config.alertingPort, () => {
    log.info('alerting listening', { port: config.alertingPort });
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
  log.error('alerting failed to start', { error: err.message });
  process.exit(1);
});
