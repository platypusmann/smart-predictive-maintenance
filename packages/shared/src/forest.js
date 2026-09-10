'use strict';

const fs = require('fs');

// Scores the random forest exported by ml/train_model.py (model.json) in plain
// JS, so the inference service doesn't need Python.

const LEAF = -1; // sklearn uses children_left == -1 for leaf nodes

class RandomForest {
  constructor(exported) {
    if (!exported || exported.format !== 'pdm-random-forest-v1') {
      throw new Error('Unsupported model format; expected pdm-random-forest-v1');
    }
    if (!Array.isArray(exported.trees) || exported.trees.length === 0) {
      throw new Error('Model export contains no trees');
    }

    this.featureNames = exported.featureNames;
    this.trees = exported.trees;
    this.metadata = exported.metadata || {};
    this.modelVersion = this.metadata.modelVersion || 'unknown';
  }

  static fromFile(path) {
    return new RandomForest(JSON.parse(fs.readFileSync(path, 'utf8')));
  }

  // probability of "failing" from one tree
  static scoreTree(tree, features) {
    let node = 0;
    while (tree.left[node] !== LEAF) {
      // same as sklearn: go left if feature <= threshold
      node = features[tree.feature[node]] <= tree.threshold[node]
        ? tree.left[node]
        : tree.right[node];
    }
    return tree.value[node];
  }

  // average over all the trees (same as predict_proba)
  predictProba(features) {
    if (!Array.isArray(features) || features.length !== this.featureNames.length) {
      throw new Error(
        `Expected ${this.featureNames.length} features, received ${
          Array.isArray(features) ? features.length : typeof features
        }`
      );
    }
    for (let i = 0; i < features.length; i += 1) {
      if (!Number.isFinite(features[i])) {
        throw new Error(`Feature ${this.featureNames[i]} is not a finite number`);
      }
    }

    let total = 0;
    for (const tree of this.trees) {
      total += RandomForest.scoreTree(tree, features);
    }
    return total / this.trees.length;
  }

  score(features, threshold = 0.5) {
    const riskScore = this.predictProba(features);
    return {
      riskScore,
      predictedFailing: riskScore >= threshold,
      modelVersion: this.modelVersion,
    };
  }
}

module.exports = { RandomForest, LEAF };
