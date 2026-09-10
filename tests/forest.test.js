'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { RandomForest, featureNames } = require('@pdm/shared');

const MODEL_PATH = path.resolve(__dirname, '../ml/artifacts/model.json');
const hasModel = fs.existsSync(MODEL_PATH);

// small hand made forest with two trees:
//   tree 0: if f0 <= 5 -> 0.1 else -> 0.9
//   tree 1: if f1 <= 0 -> 0.2 else -> 0.6
const TOY_MODEL = {
  format: 'pdm-random-forest-v1',
  featureNames: ['f0', 'f1'],
  nClasses: 2,
  positiveClassIndex: 1,
  trees: [
    {
      feature: [0, -2, -2],
      threshold: [5, -2, -2],
      left: [1, -1, -1],
      right: [2, -1, -1],
      value: [0.5, 0.1, 0.9],
    },
    {
      feature: [1, -2, -2],
      threshold: [0, -2, -2],
      left: [1, -1, -1],
      right: [2, -1, -1],
      value: [0.4, 0.2, 0.6],
    },
  ],
  metadata: { modelVersion: 'toy-1' },
};

test('rejects an unknown export format', () => {
  assert.throws(
    () => new RandomForest({ format: 'something-else', trees: [] }),
    /Unsupported model format/
  );
});

test('rejects an export with no trees', () => {
  assert.throws(
    () => new RandomForest({ ...TOY_MODEL, trees: [] }),
    /no trees/
  );
});

test('averages the positive-class probability across trees', () => {
  const forest = new RandomForest(TOY_MODEL);
  // f0=1 takes tree 0 left (0.1); f1=1 takes tree 1 right (0.6). Mean = 0.35.
  assert.ok(Math.abs(forest.predictProba([1, 1]) - 0.35) < 1e-12);
  // f0=9 takes tree 0 right (0.9); f1=-1 takes tree 1 left (0.2). Mean = 0.55.
  assert.ok(Math.abs(forest.predictProba([9, -1]) - 0.55) < 1e-12);
});

test('applies the <= split rule exactly at the threshold', () => {
  const forest = new RandomForest(TOY_MODEL);
  // sklearn sends values equal to the threshold down the LEFT branch.
  const atThreshold = forest.predictProba([5, -1]);
  const justAbove = forest.predictProba([5.0000001, -1]);
  assert.ok(Math.abs(atThreshold - 0.15) < 1e-12);
  assert.ok(Math.abs(justAbove - 0.55) < 1e-12);
});

test('validates the feature vector length and contents', () => {
  const forest = new RandomForest(TOY_MODEL);
  assert.throws(() => forest.predictProba([1]), /Expected 2 features/);
  assert.throws(() => forest.predictProba('nope'), /Expected 2 features/);
  assert.throws(() => forest.predictProba([1, NaN]), /not a finite number/);
});

test('score() applies the supplied threshold', () => {
  const forest = new RandomForest(TOY_MODEL);
  assert.strictEqual(forest.score([9, 1], 0.5).predictedFailing, true);
  assert.strictEqual(forest.score([9, 1], 0.9).predictedFailing, false);
  assert.strictEqual(forest.score([1, 1]).modelVersion, 'toy-1');
});

test('trained model loads and scores in the expected range', { skip: !hasModel }, () => {
  const forest = RandomForest.fromFile(MODEL_PATH);
  assert.deepStrictEqual(forest.featureNames, featureNames());
  assert.ok(forest.trees.length > 0);

  const zeros = new Array(featureNames().length).fill(0);
  const score = forest.predictProba(zeros);
  assert.ok(score >= 0 && score <= 1, `score ${score} outside [0,1]`);
});

test('a degrading machine scores higher than a healthy one', { skip: !hasModel }, () => {
  const forest = RandomForest.fromFile(MODEL_PATH);
  const names = featureNames();
  const build = (overrides) => {
    const vector = new Array(names.length).fill(0);
    for (const [name, value] of Object.entries(overrides)) {
      vector[names.indexOf(name)] = value;
    }
    return vector;
  };

  // Healthy pump baselines against a clearly faulted machine.
  const healthy = build({
    vibration_mean: 2.5, vibration_min: 2.3, vibration_max: 2.7, vibration_std: 0.12,
    temperature_mean: 55, temperature_max: 56, current_mean: 12, current_min: 11.7,
    rpm_mean: 1450, runtime_hours: 2,
  });
  const failing = build({
    vibration_mean: 6.5, vibration_min: 6.2, vibration_max: 6.9, vibration_std: 0.15,
    temperature_mean: 76, temperature_max: 78, current_mean: 18, current_min: 17.5,
    rpm_mean: 1280, runtime_hours: 8,
  });

  assert.ok(
    forest.predictProba(failing) > forest.predictProba(healthy),
    'faulted feature vector should score higher than a healthy one'
  );
});
