'use strict';

function createLogger(service) {
  function write(level, message, fields) {
    let line = `${new Date().toISOString()} [${service}] ${level} ${message}`;
    if (fields) line += ` ${JSON.stringify(fields)}`;
    if (level === 'INFO') console.log(line);
    else console.error(line);
  }

  return {
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARN', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
  };
}

// counters + latency numbers for the /metrics endpoints
class Metrics {
  constructor() {
    this.counters = new Map();
    this.latencies = [];
    this.startedAt = Date.now();
  }

  increment(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }

  observeLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > 5000) this.latencies.shift();
  }

  percentile(p) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
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
      },
    };
  }
}

module.exports = { createLogger, Metrics };
