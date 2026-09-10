'use strict';

// Sensor simulator - publishes a reading for every machine to MQTT each interval.
// Usage: node src/index.js --machines 20 --interval 1000 --time-scale 120

const mqtt = require('mqtt');
const { createLogger, TOPICS, loadConfig } = require('@pdm/shared');
const { SimulatedMachine, MACHINE_TYPES } = require('./machine');

const log = createLogger('simulator');
const config = loadConfig();

function parseArgs(argv) {
  const args = {
    machines: 10,
    interval: 1000,
    timeScale: 120,
    seed: 314,
    healthyRatio: 0.4,
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = Number(argv[i + 1]);
    if (key === 'machines') args.machines = value;
    if (key === 'interval') args.interval = value;
    if (key === 'time-scale') args.timeScale = value;
    if (key === 'seed') args.seed = value;
    if (key === 'healthy-ratio') args.healthyRatio = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const types = Object.keys(MACHINE_TYPES);

  const fleet = [];
  for (let i = 0; i < args.machines; i += 1) {
    fleet.push(new SimulatedMachine({
      id: `M-${String(i + 1).padStart(4, '0')}`,
      type: types[i % types.length],
      seed: args.seed + i * 7919,
      timeScale: args.timeScale,
      // some machines never develop a fault so we get healthy ones too
      forceHealthy: i % Math.max(1, Math.round(1 / args.healthyRatio)) === 0,
    }));
  }

  const client = await mqtt.connectAsync(config.mqttUrl, { clientId: `simulator-${process.pid}` });
  log.info('simulator started', {
    machines: fleet.length,
    intervalMs: args.interval,
    timeScale: args.timeScale,
  });

  let published = 0;
  let resetSeed = args.seed + 1000000;

  setInterval(() => {
    for (const machine of fleet) {
      const reading = machine.tick(args.interval / 1000);
      client.publish(`${TOPICS.RAW_READINGS}/${machine.id}`, JSON.stringify(reading));
      published += 1;

      // swap failed machines for a fresh one so the demo keeps going
      if (machine.failed) {
        resetSeed += 7919;
        machine.reset(resetSeed);
      }
    }

    if (published % (fleet.length * 30) === 0) {
      log.info('publishing', { readingsPublished: published });
    }
  }, args.interval);
}

main().catch((err) => {
  log.error('simulator failed to start', { error: err.message });
  process.exit(1);
});
