'use strict';

// Dashboard - serves the web page and pulls /metrics from the other services

const path = require('path');
const express = require('express');
const { loadConfig, createLogger } = require('@pdm/shared');

const config = loadConfig();
const log = createLogger('dashboard');

const TARGETS = {
  ingestion: process.env.INGESTION_URL || 'http://localhost:3001',
  inference: process.env.INFERENCE_URL || 'http://localhost:3002',
  alerting: process.env.ALERTING_URL || 'http://localhost:3003',
};

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (err) {
    return { error: err.message };
  }
}

const app = express();
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
  log.info(`listening on port ${config.dashboardPort}`);
});
