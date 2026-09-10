'use strict';

// Messaging between the services.
// Locally everything goes through the MQTT broker. On AWS we set USE_SQS=true
// and the services use the SQS queues instead.

const mqtt = require('mqtt');
const { loadConfig, TOPICS } = require('./config');

const config = loadConfig();

const queueUrls = {
  [TOPICS.FEATURES]: config.featuresQueueUrl,
  [TOPICS.HIGH_RISK]: config.highRiskQueueUrl,
};

let mqttClient;
let aws; // AWS SDK, only loaded when USE_SQS=true (it's slow to load)
let sqs;
const handlers = {};

async function connect(clientId) {
  if (config.useSqs) {
    aws = require('@aws-sdk/client-sqs');
    sqs = new aws.SQSClient({ region: config.awsRegion });
    return;
  }

  mqttClient = await mqtt.connectAsync(config.mqttUrl, { clientId });
  mqttClient.on('message', (topic, payload) => {
    const handler = handlers[topic];
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(JSON.parse(payload.toString())))
      .catch((err) => console.error(`error handling message on ${topic}: ${err.message}`));
  });
}

async function publish(topic, message) {
  const body = JSON.stringify(message);
  if (config.useSqs) {
    await sqs.send(new aws.SendMessageCommand({ QueueUrl: queueUrls[topic], MessageBody: body }));
  } else {
    await mqttClient.publishAsync(topic, body, { qos: 1 });
  }
}

async function subscribe(topic, handler) {
  if (config.useSqs) {
    pollQueue(queueUrls[topic], handler); // not awaited, runs forever
  } else {
    handlers[topic] = handler;
    await mqttClient.subscribeAsync(topic, { qos: 1 });
  }
}

async function pollQueue(queueUrl, handler) {
  while (true) {
    let messages = [];
    try {
      const res = await sqs.send(new aws.ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // long polling
      }));
      messages = res.Messages || [];
    } catch (err) {
      console.error(`SQS receive failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    for (const msg of messages) {
      try {
        await handler(JSON.parse(msg.Body));
        // only delete after it's handled, otherwise SQS gives it to someone else later
        await sqs.send(new aws.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }));
      } catch (err) {
        console.error(`error handling message: ${err.message}`);
      }
    }
  }
}

module.exports = { connect, publish, subscribe };
