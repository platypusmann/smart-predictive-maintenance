'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  featureNames,
  extractFeatures,
  slope,
  populationStd,
  RollingWindow,
  CHANNELS,
} = require('@pdm/shared');

function reading(values) {
  return { vibration: 0, temperature: 0, current: 0, rpm: 0, ...values };
}

test('feature names are stable, ordered and unique', () => {
  const names = featureNames();
  assert.strictEqual(names.length, CHANNELS.length * 5 + 1);
  assert.strictEqual(names[0], 'vibration_mean');
  assert.strictEqual(names.at(-1), 'runtime_hours');
  assert.strictEqual(new Set(names).size, names.length);
});

test('slope recovers a known linear trend', () => {
  // y = 3x + 10 has slope 3 regardless of the intercept.
  const values = Array.from({ length: 20 }, (_, i) => 3 * i + 10);
  assert.ok(Math.abs(slope(values) - 3) < 1e-12);
});

test('slope of a flat series is zero and a single point is zero', () => {
  assert.strictEqual(slope([5, 5, 5, 5]), 0);
  assert.strictEqual(slope([42]), 0);
  assert.strictEqual(slope([]), 0);
});

test('populationStd uses ddof=0 to match numpy', () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  // Population std of this classic series is exactly 2.
  assert.ok(Math.abs(populationStd(values, 5) - 2) < 1e-12);
});

test('extractFeatures produces the documented layout', () => {
  const window = [
    reading({ vibration: 1, temperature: 10, current: 5, rpm: 100 }),
    reading({ vibration: 3, temperature: 20, current: 7, rpm: 200 }),
  ];
  const vector = extractFeatures(window, 2.5);

  assert.strictEqual(vector.length, featureNames().length);
  // vibration: mean, std, min, max, slope
  assert.strictEqual(vector[0], 2);
  assert.strictEqual(vector[1], 1);
  assert.strictEqual(vector[2], 1);
  assert.strictEqual(vector[3], 3);
  assert.strictEqual(vector[4], 2);
  assert.strictEqual(vector.at(-1), 2.5);
});

test('extractFeatures rejects empty windows and non-numeric channels', () => {
  assert.throws(() => extractFeatures([], 0), /non-empty window/);
  assert.throws(
    () => extractFeatures([reading({ vibration: 'hot' })], 0),
    /not a finite number/
  );
});

test('RollingWindow emits nothing until it is full', () => {
  const window = new RollingWindow({ size: 5, stride: 5 });
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(window.push(reading({ vibration: i })), null);
  }
  const emitted = window.push(reading({ vibration: 4 }));
  assert.ok(emitted);
  assert.strictEqual(emitted.sampleCount, 5);
  assert.strictEqual(emitted.features.length, featureNames().length);
});

test('RollingWindow respects the stride after the first emit', () => {
  const window = new RollingWindow({ size: 3, stride: 2 });
  window.push(reading({}));
  window.push(reading({}));
  assert.ok(window.push(reading({})), 'emits once full');

  assert.strictEqual(window.push(reading({})), null, 'stride not yet elapsed');
  assert.ok(window.push(reading({})), 'emits again after the stride');
});

test('RollingWindow keeps only the most recent readings', () => {
  const window = new RollingWindow({ size: 3, stride: 1 });
  for (let i = 0; i < 10; i += 1) window.push(reading({ vibration: i }));
  assert.strictEqual(window.buffer.length, 3);
  // The last three vibration values pushed were 7, 8 and 9, so the mean is 8.
  const emitted = window.push(reading({ vibration: 9 }));
  assert.strictEqual(window.buffer.length, 3);
  assert.ok(emitted.features[0] > 8);
});
