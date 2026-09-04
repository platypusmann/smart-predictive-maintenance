'use strict';

/**
 * Start the whole local stack in dependency order with one command.
 *
 * Services are started as child processes rather than containers so the stack
 * runs anywhere Node runs, with no Docker requirement. docker-compose.yml
 * provides the containerised equivalent for anyone who prefers it.
 *
 * Usage:
 *   node scripts/run-stack.js                    # 20 machines via the edge bridge
 *   node scripts/run-stack.js --machines 100
 *   node scripts/run-stack.js --no-simulator     # for the load test
 *   node scripts/run-stack.js --node-red         # skip the bridge, use Node-RED
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    machines: 20,
    timeScale: 120,
    // Sensor sampling period. 1000ms is realistic; shorter values compress a
    // full run-to-failure cycle into a demo-length window.
    interval: 1000,
    // 0 means run until interrupted. A positive value runs for that many
    // seconds, prints a metrics summary and exits, which is how the evidence
    // for the report is captured reproducibly.
    duration: 0,
    simulator: true,
    edge: true,
    dashboard: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--no-simulator') args.simulator = false;
    else if (token === '--no-dashboard') args.dashboard = false;
    else if (token === '--node-red') args.edge = false;
    else if (token === '--machines') args.machines = Number(argv[++i]);
    else if (token === '--time-scale') args.timeScale = Number(argv[++i]);
    else if (token === '--interval') args.interval = Number(argv[++i]);
    else if (token === '--duration') args.duration = Number(argv[++i]);
  }
  return args;
}

const COLOURS = {
  broker: '\x1b[90m',
  ingestion: '\x1b[36m',
  inference: '\x1b[35m',
  alerting: '\x1b[33m',
  dashboard: '\x1b[32m',
  simulator: '\x1b[34m',
  edge: '\x1b[37m',
};
const RESET = '\x1b[0m';

const children = [];

function start(name, file, extraArgs = [], env = {}) {
  const child = spawn('node', [path.join(ROOT, file), ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${COLOURS[name] || ''}[${name}]${RESET}`;
  const relay = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        // Log lines are JSON; print the message and drop the noise.
        try {
          const parsed = JSON.parse(line);
          const extras = Object.entries(parsed)
            .filter(([k]) => !['ts', 'level', 'service', 'instance', 'message'].includes(k))
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' ');
          target.write(`${prefix} ${parsed.message}${extras ? ` ${extras}` : ''}\n`);
        } catch (err) {
          target.write(`${prefix} ${line}\n`);
        }
      }
    });
  };

  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) {
      process.stdout.write(`${prefix} exited with code ${code}\n`);
    }
  });

  children.push({ name, child });
  return child;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;

async function main() {
  const args = parseArgs(process.argv);

  const env = {
    STORE_DRIVER: process.env.STORE_DRIVER || 'memory',
    EVENT_BUS_DRIVER: process.env.EVENT_BUS_DRIVER || 'mqtt',
    MQTT_URL: process.env.MQTT_URL || 'mqtt://localhost:1883',
    API_KEY: process.env.API_KEY || 'local-dev-key',
    RISK_THRESHOLD: process.env.RISK_THRESHOLD || '0.7',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  };

  console.log('Starting local stack');
  console.log(`  store       : ${env.STORE_DRIVER}`);
  console.log(`  event bus   : ${env.EVENT_BUS_DRIVER}`);
  console.log(`  machines    : ${args.simulator ? args.machines : 'simulator disabled'}`);
  console.log(`  edge        : ${args.edge ? 'edge-bridge' : 'Node-RED (start it yourself)'}`);
  console.log('');

  start('broker', 'services/broker/src/server.js', [], env);
  await wait(700); // broker must accept connections before anything subscribes

  start('ingestion', 'services/ingestion/src/server.js', [], env);
  start('inference', 'services/inference/src/server.js', [], env);
  start('alerting', 'services/alerting/src/server.js', [], env);
  await wait(1200); // let the HTTP listeners bind before traffic starts

  if (args.dashboard) start('dashboard', 'services/dashboard/src/server.js', [], env);

  if (args.edge) {
    start('edge', 'services/edge-bridge/src/index.js', [], env);
  }

  if (args.simulator) {
    start(
      'simulator',
      'services/simulator/src/index.js',
      [
        '--machines', String(args.machines),
        '--time-scale', String(args.timeScale),
        '--interval', String(args.interval),
      ],
      env
    );
  }

  if (args.duration > 0) {
    console.log(`\nStack running for ${args.duration}s, then reporting.\n`);
    await wait(args.duration * 1000);
    await report();
    shutdown();
    return;
  }

  console.log('\nStack running. Dashboard: http://localhost:3000');
  console.log('Press Ctrl+C to stop everything.\n');
}

/** Collect a metrics summary from every service at the end of a timed run. */
async function report() {
  const fetchJson = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      return response.ok ? await response.json() : { error: `HTTP ${response.status}` };
    } catch (err) {
      return { error: err.message };
    }
  };

  const [ingestion, inference, alerting, workOrders] = await Promise.all([
    fetchJson('http://localhost:3001/metrics'),
    fetchJson('http://localhost:3002/metrics'),
    fetchJson('http://localhost:3003/metrics'),
    fetchJson('http://localhost:3003/api/v1/work-orders?limit=10'),
  ]);

  console.log('\n================ RUN SUMMARY ================');
  const line = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`);

  line('readings accepted', ingestion.counters?.readings_accepted ?? 'n/a');
  line('events published', ingestion.counters?.events_published ?? 'n/a');
  line('ingest p95 latency', `${ingestion.latencyMs?.p95 ?? 'n/a'} ms`);
  line('predictions scored', inference.counters?.predictions_scored ?? 'n/a');
  line('high-risk events', inference.counters?.high_risk_published ?? 0);
  line('inference p95 latency', `${inference.latencyMs?.p95 ?? 'n/a'} ms`);
  line('machines tracked by alerting', alerting.trackedMachines ?? 0);
  line('work orders raised', alerting.counters?.work_orders_created ?? 0);
  line('alerts suppressed (cooldown)', alerting.counters?.decision_suppressed ?? 0);

  const orders = workOrders.workOrders || [];
  if (orders.length > 0) {
    console.log('\n  Open work orders:');
    for (const wo of orders.slice(0, 5)) {
      console.log(
        `    ${wo.machineId}  risk ${Number(wo.riskScore).toFixed(3)}  ` +
        `after ${wo.consecutiveBreaches} confirmed windows`
      );
    }
  }
  console.log('=============================================\n');
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping stack...');
  // Reverse order so producers stop before the broker they depend on.
  for (const { child } of [...children].reverse()) {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL');
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Failed to start stack:', err.message);
  shutdown();
});
