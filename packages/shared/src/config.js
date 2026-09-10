'use strict';

// MQTT topics. On AWS the FEATURES and HIGH_RISK topics are SQS queues instead.
const TOPICS = {
  RAW_READINGS: 'pdm/readings/raw', // simulator -> Node-RED
  FEATURES: 'pdm/events/features', // ingestion -> inference
  HIGH_RISK: 'pdm/events/high-risk', // inference -> alerting
};

function loadConfig() {
  return {
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/pdm',

    mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
    useSqs: process.env.USE_SQS === 'true',
    awsRegion: process.env.AWS_REGION || 'ap-southeast-2',
    featuresQueueUrl: process.env.FEATURES_QUEUE_URL || '',
    highRiskQueueUrl: process.env.HIGH_RISK_QUEUE_URL || '',

    ingestionPort: Number(process.env.INGESTION_PORT || 3001),
    inferencePort: Number(process.env.INFERENCE_PORT || 3002),
    alertingPort: Number(process.env.ALERTING_PORT || 3003),
    dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
    ingestionUrl: process.env.INGESTION_URL || 'http://localhost:3001',

    modelPath: process.env.MODEL_PATH || '',
    riskThreshold: Number(process.env.RISK_THRESHOLD || 0.7),
    // need this many high risk windows in a row before raising a work order
    consecutiveBreaches: Number(process.env.CONSECUTIVE_BREACHES || 3),
    alertCooldownMs: Number(process.env.ALERT_COOLDOWN_MS || 15 * 60 * 1000),

    apiKey: process.env.API_KEY || 'local-dev-key',
  };
}

module.exports = { loadConfig, TOPICS };
