'use strict';

/**
 * Sensor simulator.
 *
 * Stands in for the field hardware described in the project plan (accelerometer,
 * thermocouple, clamp current sensor, tachometer) by publishing one JSON reading
 * per machine per second to MQTT. Machine count is a command line argument,
 * which is what makes the scalability experiments possible: the same process
 * drives 10 machines during development and 500 during the load test.
 *
 * Usage:
 *   node src/index.js --machines 20 --interval 1000 --time-scale 120
 */

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
    prefix: 'M',
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    switch (key) {
      case 'machines': args.machines = Number(value); break;
      case 'interval': args.interval = Number(value); break;
      case 'time-scale': args.timeScale = Number(value); break;
      case 'seed': args.seed = Number(value); break;
      case 'healthy-ratio': args.healthyRatio = Number(value); break;
      case 'prefix': args.prefix = String(value); break;
      default: break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const types = Object.keys(MACHINE_TYPES);

  const fleet = [];
  for (let i = 0; i < args.machines; i += 1) {
    fleet.push(
      new SimulatedMachine({
        id: `${args.prefix}-${String(i + 1).padStart(4, '0')}`,
        type: types[i % types.length],
        seed: args.seed + i * 7919,
        timeScale: args.timeScale,
        // A share of the fleet never develops a fault, so the pipeline is
        // exercised with true negatives and not just degrading machines.
        forceHealthy: i % Math.max(1, Math.round(1 / args.healthyRatio)) === 0,
      })
    );
  }

  const client = mqtt.connect(config.mqttUrl, {
    clientId: `simulator-${args.prefix}-${process.pid}`,
    reconnectPeriod: 2000,
  });

  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });

  log.info('simulator started', {
    machines: fleet.length,
    intervalMs: args.interval,
    timeScale: args.timeScale,
    broker: config.mqttUrl,
  });

  let published = 0;
  let replacements = 0;
  let resetSeed = args.seed + 1000000;

  const timer = setInterval(() => {
    for (const machine of fleet) {
      const reading = machine.tick(args.interval / 1000);
      // Per-machine topic so Node-RED can subscribe with a wildcard and still
      // key its rolling windows off the topic without parsing every payload.
      client.publish(
        `${TOPICS.RAW_READINGS}/${machine.id}`,
        JSON.stringify(reading),
        { qos: 0 }
      );
      published += 1;

      if (machine.failed) {
        // A failed machine is repaired and returned to service, so a long run
        // produces a continuous stream of complete degradation cycles.
        machine.reset((resetSeed += 7919));
        replacements += 1;
      }
    }

    if (published % (fleet.length * 30) === 0) {
      log.info('publishing', { readingsPublished: published, replacements });
    }
  }, args.interval);

  const shutdown = (signal) => {
    log.info('shutting down', { signal, readingsPublished: published });
    clearInterval(timer);
    client.end(false, {}, () => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('simulator failed to start', { error: err.message });
  process.exit(1);
});
