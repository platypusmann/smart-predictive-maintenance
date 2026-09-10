'use strict';

// Used by verify_parity.py. Reads windows from stdin, runs them through the JS
// feature extraction and model, and prints the results as JSON.

const path = require('path');
const { extractFeatures, RandomForest } = require('../packages/shared/src/index.js');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const forest = RandomForest.fromFile(path.resolve(__dirname, 'artifacts/model.json'));

  const features = [];
  const scores = [];
  for (const item of input.cases) {
    const vector = extractFeatures(item.window, item.runtimeHours);
    features.push(vector);
    scores.push(forest.predictProba(vector));
  }

  process.stdout.write(JSON.stringify({ features, scores }));
});
