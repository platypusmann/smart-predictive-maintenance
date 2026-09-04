'use strict';

/**
 * Node half of the Python/JS parity check.
 *
 * Reads windows from stdin, computes features with the shared JS module and
 * scores them with the JS forest, then writes the results to stdout for
 * verify_parity.py to compare against scikit-learn.
 */

const path = require('path');
const { extractFeatures, RandomForest } = require(
  path.resolve(__dirname, '../packages/shared/src/index.js')
);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const forest = RandomForest.fromFile(
    path.resolve(__dirname, 'artifacts/model.json')
  );

  const features = [];
  const scores = [];
  for (const case_ of input.cases) {
    const vector = extractFeatures(case_.window, case_.runtimeHours);
    features.push(vector);
    scores.push(forest.predictProba(vector));
  }

  process.stdout.write(JSON.stringify({ features, scores }));
});
