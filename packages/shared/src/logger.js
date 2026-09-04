'use strict';

/**
 * Minimal structured logger. Emits one JSON object per line so CloudWatch Logs
 * Insights can query the fields directly during the scaling experiments.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(service, level = process.env.LOG_LEVEL || 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, message, fields = {}) {
    if (LEVELS[levelName] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: levelName,
      service,
      // Present in ECS so log lines can be attributed to a specific task
      // while the service scales out.
      instance: process.env.HOSTNAME || process.pid,
      message,
      ...fields,
    });
    if (levelName === 'error' || levelName === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

/**
 * Counters and latency samples exposed on /metrics. The load test scrapes this
 * endpoint to build the throughput and latency evidence for the report.
 */
class Metrics {
  constructor() {
    this.counters = new Map();
    this.latencies = [];
    this.maxLatencySamples = 5000;
    this.startedAt = Date.now();
  }

  increment(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }

  observeLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxLatencySamples) {
      this.latencies.shift();
    }
  }

  percentile(p) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
    );
    return Number(sorted[index].toFixed(2));
  }

  snapshot() {
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      latencyMs: {
        samples: this.latencies.length,
        p50: this.percentile(50),
        p95: this.percentile(95),
        p99: this.percentile(99),
      },
    };
  }
}

module.exports = { createLogger, Metrics };
