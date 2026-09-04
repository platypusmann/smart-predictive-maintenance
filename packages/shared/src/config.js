'use strict';

/**
 * Central configuration. Every value is environment-driven so the same image
 * runs locally (MQTT + in-memory or local Mongo) and on AWS (SQS + Atlas)
 * without a code change.
 */

// Topic / queue names. With the SQS driver these map to queue URLs via
// SQS_QUEUE_URLS; with the MQTT driver they are used as topic strings directly.
const TOPICS = {
  RAW_READINGS: 'pdm/readings/raw',       // simulator -> Node-RED
  FEATURES: 'pdm/events/features',        // ingestion -> inference
  HIGH_RISK: 'pdm/events/high-risk',      // inference -> alerting
};

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Environment variable ${name} is not valid JSON`);
  }
}

function loadConfig() {
  return {
    env: process.env.NODE_ENV || 'development',

    // Storage: "memory" needs no database and is used for tests and quick
    // demos; "mongo" is the real path used for the recorded evidence.
    storeDriver: process.env.STORE_DRIVER || 'memory',
    mongoUri: process.env.MONGO_URI || '',
    mongoDbName: process.env.MONGO_DB_NAME || 'pdm',

    // Messaging
    eventBusDriver: process.env.EVENT_BUS_DRIVER || 'mqtt',
    mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
    awsRegion: process.env.AWS_REGION || 'ap-southeast-2',
    sqsQueueUrls: parseJsonEnv('SQS_QUEUE_URLS', {}),

    // Service endpoints and ports
    ingestionPort: Number(process.env.INGESTION_PORT || 3001),
    inferencePort: Number(process.env.INFERENCE_PORT || 3002),
    alertingPort: Number(process.env.ALERTING_PORT || 3003),
    dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
    brokerPort: Number(process.env.BROKER_PORT || 1883),
    ingestionUrl: process.env.INGESTION_URL || 'http://localhost:3001',

    // Model + decision policy
    modelPath: process.env.MODEL_PATH || '',
    riskThreshold: Number(process.env.RISK_THRESHOLD || 0.7),
    // A work order is only raised after this many consecutive breaches, which
    // stops a single noisy window from paging a technician at 3am.
    consecutiveBreaches: Number(process.env.CONSECUTIVE_BREACHES || 3),
    // Suppress repeat work orders for the same machine within this window.
    alertCooldownMs: Number(process.env.ALERT_COOLDOWN_MS || 15 * 60 * 1000),

    // Security
    apiKey: process.env.API_KEY || '',
    requireApiKey: process.env.REQUIRE_API_KEY !== 'false',

    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

module.exports = { loadConfig, TOPICS };
