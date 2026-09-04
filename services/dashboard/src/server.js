'use strict';

/**
 * Analytics dashboard.
 *
 * Deliberately thin: it holds no state of its own and simply fans out to the
 * /metrics and /api endpoints of the other services, so it can be pointed at a
 * local stack or at the deployed AWS load balancers by changing environment
 * variables. During the scaling experiments it is the single place to watch
 * throughput, latency and work orders at once.
 */

const path = require('path');
const express = require('express');
const { loadConfig, createLogger } = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('dashboard', config.logLevel);

const TARGETS = {
  ingestion: process.env.INGESTION_URL || 'http://localhost:3001',
  inference: process.env.INFERENCE_URL || 'http://localhost:3002',
  alerting: process.env.ALERTING_URL || 'http://localhost:3003',
};

/** Fetch with a short timeout so one dead service cannot hang the page. */
async function fetchJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'dashboard' }));

app.get('/api/overview', async (req, res) => {
  const [ingestion, inference, alerting, workOrders] = await Promise.all([
    fetchJson(`${TARGETS.ingestion}/metrics`),
    fetchJson(`${TARGETS.inference}/metrics`),
    fetchJson(`${TARGETS.alerting}/metrics`),
    fetchJson(`${TARGETS.alerting}/api/v1/work-orders?limit=20`),
  ]);

  res.json({
    fetchedAt: new Date().toISOString(),
    services: { ingestion, inference, alerting },
    workOrders: workOrders.workOrders || [],
  });
});

app.listen(config.dashboardPort, () => {
  log.info('dashboard listening', { port: config.dashboardPort, targets: TARGETS });
});
