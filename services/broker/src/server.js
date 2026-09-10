'use strict';

// Local MQTT broker (Aedes) so we don't need Mosquitto installed.
// Not used on AWS.

const net = require('net');
const Aedes = require('aedes');
const { createLogger } = require('@pdm/shared');

const log = createLogger('broker');
const port = Number(process.env.BROKER_PORT || 1883);

const aedes = new Aedes();
const server = net.createServer(aedes.handle);

aedes.on('client', (client) => {
  log.info('client connected', { clientId: client?.id });
});

aedes.on('clientDisconnect', (client) => {
  log.info('client disconnected', { clientId: client?.id });
});

server.listen(port, () => {
  log.info(`MQTT broker listening on port ${port}`);
});
