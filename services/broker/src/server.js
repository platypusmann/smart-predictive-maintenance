'use strict';

/**
 * Local MQTT broker (Aedes).
 *
 * Running the broker in-process means the whole platform starts with npm alone
 * on any machine, with no Mosquitto install and no Docker requirement. In the
 * AWS deployment this service is not used: EVENT_BUS_DRIVER is switched to sqs
 * and AWS IoT Core / SQS take its place.
 */

const net = require('net');
const Aedes = require('aedes');
const { createLogger } = require('@pdm/shared');

const log = createLogger('broker');
const port = Number(process.env.BROKER_PORT || 1883);

const aedes = new Aedes();
const server = net.createServer(aedes.handle);

let published = 0;

aedes.on('client', (client) => {
  log.info('client connected', { clientId: client?.id });
});

aedes.on('clientDisconnect', (client) => {
  log.info('client disconnected', { clientId: client?.id });
});

aedes.on('publish', (packet, client) => {
  // $SYS packets are internal keepalives, not application traffic.
  if (!client || String(packet.topic).startsWith('$SYS')) return;
  published += 1;
  if (published % 1000 === 0) {
    log.info('broker throughput', { messagesPublished: published });
  }
});

server.listen(port, () => {
  log.info('MQTT broker listening', { port });
});

function shutdown(signal) {
  log.info('shutting down', { signal, messagesPublished: published });
  server.close(() => aedes.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
