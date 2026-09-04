'use strict';

/**
 * Canonical feature definition for the predictive maintenance model.
 *
 * IMPORTANT: this file and ml/features.py MUST stay in sync. The parity test
 * (`npm run verify:parity`) proves both produce identical vectors for the same
 * window; if you change a statistic here, change it there too.
 */

// Raw sensor channels captured from each machine, in a fixed order.
const CHANNELS = ['vibration', 'temperature', 'current', 'rpm'];

// Statistics computed per channel over a rolling window.
const STATS = ['mean', 'std', 'min', 'max', 'slope'];

const WINDOW_SIZE = 30; // readings per window (30 s at 1 Hz)

/** Canonical, ordered list of feature names. */
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

/**
 * Least-squares slope of `values` against the index 0..n-1.
 * Closed form so it matches numpy exactly without a linear algebra library.
 */
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

/** Population standard deviation (ddof = 0), matching numpy's default. */
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

/**
 * Turn a window of raw readings into an ordered feature vector.
 *
 * @param {Array<Object>} window   readings, each containing every CHANNELS key
 * @param {number} runtimeHours    machine runtime at the end of the window
 * @returns {number[]}             ordered exactly as featureNames()
 */
function extractFeatures(window, runtimeHours) {
  if (!Array.isArray(window) || window.length === 0) {
    throw new Error('extractFeatures requires a non-empty window');
  }

  const vector = [];
  for (const channel of CHANNELS) {
    const series = new Array(window.length);
    for (let i = 0; i < window.length; i += 1) {
      const value = Number(window[i][channel]);
      if (!Number.isFinite(value)) {
        throw new Error(`window[${i}].${channel} is not a finite number`);
      }
      series[i] = value;
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < series.length; i += 1) {
      sum += series[i];
      if (series[i] < min) min = series[i];
      if (series[i] > max) max = series[i];
    }
    const mean = sum / series.length;

    vector.push(mean);
    vector.push(populationStd(series, mean));
    vector.push(min);
    vector.push(max);
    vector.push(slope(series));
  }

  vector.push(Number(runtimeHours) || 0);
  return vector;
}

/**
 * Fixed-size rolling buffer of raw readings, one per machine.
 * Emits a feature vector once it is full and the stride has elapsed.
 */
class RollingWindow {
  constructor({ size = WINDOW_SIZE, stride = 10 } = {}) {
    this.size = size;
    this.stride = stride;
    this.buffer = [];
    this.sinceEmit = 0;
  }

  /**
   * Push a raw reading. Returns a feature vector when one is due, else null.
   * @param {Object} reading must contain every CHANNELS key plus runtimeHours
   */
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
