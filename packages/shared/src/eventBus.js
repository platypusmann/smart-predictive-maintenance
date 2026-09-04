'use strict';

const mqtt = require('mqtt');

/**
 * Event bus abstraction with two interchangeable drivers.
 *
 *   mqtt : used for local development and load testing. One broker serves both
 *          sensor telemetry and inter-service events, so the whole stack runs
 *          on a laptop with no cloud account.
 *   sqs  : used in the AWS deployment. Queue depth is the metric that drives
 *          the inference service's auto-scaling policy, so the decoupling here
 *          is what makes the scaling demonstration possible.
 *
 * Services only ever call publish()/subscribe(), so switching drivers is a
 * change to EVENT_BUS_DRIVER and nothing else.
 */

class MqttBus {
  constructor({ url, clientId }) {
    this.driver = 'mqtt';
    this.url = url;
    this.clientId = clientId;
    this.client = null;
    this.handlers = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.url, {
        clientId: this.clientId,
        reconnectPeriod: 2000,
        connectTimeout: 10000,
        clean: true,
      });
      this.client.once('connect', resolve);
      this.client.once('error', reject);
    });

    this.client.on('message', (topic, payload) => {
      const handler = this.handlers.get(topic);
      if (!handler) return;
      let message;
      try {
        message = JSON.parse(payload.toString());
      } catch (err) {
        return; // malformed payloads are dropped rather than crashing the worker
      }
      Promise.resolve(handler(message, { topic })).catch(() => {});
    });

    return this;
  }

  async publish(topic, message) {
    return new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(message), { qos: 1 }, (err) =>
        err ? reject(err) : resolve()
      );
    });
  }

  async subscribe(topic, handler) {
    this.handlers.set(topic, handler);
    return new Promise((resolve, reject) => {
      this.client.subscribe(topic, { qos: 1 }, (err) =>
        err ? reject(err) : resolve()
      );
    });
  }

  async close() {
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
    }
  }
}

class SqsBus {
  constructor({ queueUrls, region, pollWaitSeconds = 20, batchSize = 10 }) {
    this.driver = 'sqs';
    this.queueUrls = queueUrls; // { 'topic/name': 'https://sqs...' }
    this.region = region;
    this.pollWaitSeconds = pollWaitSeconds;
    this.batchSize = batchSize;
    this.client = null;
    this.pollers = [];
    this.running = false;
  }

  async connect() {
    // Required lazily so local development never needs the AWS SDK installed.
    const { SQSClient } = require('@aws-sdk/client-sqs');
    this.client = new SQSClient({ region: this.region });
    this.running = true;
    return this;
  }

  resolveQueue(topic) {
    const url = this.queueUrls[topic];
    if (!url) throw new Error(`No SQS queue configured for topic "${topic}"`);
    return url;
  }

  async publish(topic, message) {
    const { SendMessageCommand } = require('@aws-sdk/client-sqs');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.resolveQueue(topic),
        MessageBody: JSON.stringify(message),
      })
    );
  }

  async subscribe(topic, handler) {
    const {
      ReceiveMessageCommand,
      DeleteMessageCommand,
    } = require('@aws-sdk/client-sqs');
    const queueUrl = this.resolveQueue(topic);

    const poll = async () => {
      while (this.running) {
        try {
          const response = await this.client.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: this.batchSize,
              // Long polling keeps empty-receive costs and latency both low.
              WaitTimeSeconds: this.pollWaitSeconds,
            })
          );

          for (const record of response.Messages || []) {
            try {
              await handler(JSON.parse(record.Body), { topic });
              // Only delete after the handler succeeds, so a crash mid-process
              // returns the message to the queue for another consumer.
              await this.client.send(
                new DeleteMessageCommand({
                  QueueUrl: queueUrl,
                  ReceiptHandle: record.ReceiptHandle,
                })
              );
            } catch (err) {
              // Left on the queue; redrive policy sends it to the DLQ after
              // maxReceiveCount attempts.
            }
          }
        } catch (err) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };

    this.pollers.push(poll());
  }

  async close() {
    this.running = false;
    await Promise.allSettled(this.pollers);
  }
}

/** Build the bus configured by the environment. */
function createEventBus({ clientId, config }) {
  if (config.eventBusDriver === 'sqs') {
    return new SqsBus({
      queueUrls: config.sqsQueueUrls,
      region: config.awsRegion,
    });
  }
  return new MqttBus({ url: config.mqttUrl, clientId });
}

module.exports = { createEventBus, MqttBus, SqsBus };
