'use strict';

// Feature extraction. This has to give the same numbers as ml/features.py,
// otherwise the model gets different inputs to what it was trained on.

const CHANNELS = ['vibration', 'temperature', 'current', 'rpm'];
const STATS = ['mean', 'std', 'min', 'max', 'slope'];
const WINDOW_SIZE = 30; // 30 readings = 30 seconds at 1Hz

function featureNames() {
  const names = [];
  for (const channel of CHANNELS) {
    for (const stat of STATS) {
      names.push(`${channel}_${stat}`);
    }
  }
  names.push('runtime_hours');
  return names;
}

// least squares slope against x = 0..n-1
function slope(values) {
  const n = values.length;
  if (n < 2) return 0;

  let xMean = 0;
  let yMean = 0;
  for (let i = 0; i < n; i += 1) {
    xMean += i;
    yMean += values[i];
  }
  xMean /= n;
  yMean /= n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    numerator += dx * (values[i] - yMean);
    denominator += dx * dx;
  }
  if (denominator === 0) return 0;
  return numerator / denominator;
}

// population std (same as numpy's default)
function populationStd(values, mean) {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = values[i] - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

// mean, std, min, max, slope for each channel, then runtime hours on the end
function extractFeatures(window, runtimeHours) {
  if (!Array.isArray(window) || window.length === 0) {
    throw new Error('extractFeatures requires a non-empty window');
  }

  const vector = [];
  for (const channel of CHANNELS) {
    const series = window.map((reading, i) => {
      const value = Number(reading[channel]);
      if (!Number.isFinite(value)) {
        throw new Error(`window[${i}].${channel} is not a finite number`);
      }
      return value;
    });

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const value of series) {
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const mean = sum / series.length;

    vector.push(mean, populationStd(series, mean), min, max, slope(series));
  }

  vector.push(Number(runtimeHours) || 0);
  return vector;
}

// Keeps the last `size` readings for a machine and returns features every `stride` readings
class RollingWindow {
  constructor({ size = WINDOW_SIZE, stride = 10 } = {}) {
    this.size = size;
    this.stride = stride;
    this.buffer = [];
    this.sinceEmit = 0;
  }

  push(reading) {
    this.buffer.push(reading);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }

    this.sinceEmit += 1;
    if (this.buffer.length < this.size || this.sinceEmit < this.stride) {
      return null;
    }

    this.sinceEmit = 0;
    const last = this.buffer[this.buffer.length - 1];
    return {
      features: extractFeatures(this.buffer, last.runtimeHours ?? 0),
      windowEnd: last.timestamp ?? new Date().toISOString(),
      sampleCount: this.buffer.length,
    };
  }
}

module.exports = {
  CHANNELS,
  STATS,
  WINDOW_SIZE,
  featureNames,
  extractFeatures,
  slope,
  populationStd,
  RollingWindow,
};
