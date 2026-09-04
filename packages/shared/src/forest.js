'use strict';

const fs = require('fs');

/**
 * Pure-JavaScript scorer for a scikit-learn RandomForestClassifier exported by
 * ml/train_model.py. Walking the exported trees directly keeps the inference
 * microservice a plain Node.js service with no native or Python dependency,
 * and reproduces predict_proba exactly rather than approximating it.
 */

// scikit-learn marks leaves with children_left == -1.
const LEAF = -1;

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

  /** Probability of the positive (failing) class from a single tree. */
  static scoreTree(tree, features) {
    let node = 0;
    // children_left[node] === LEAF marks a leaf in the sklearn tree layout.
    while (tree.left[node] !== LEAF) {
      // sklearn's split rule is: go left when X[feature] <= threshold.
      node = features[tree.feature[node]] <= tree.threshold[node]
        ? tree.left[node]
        : tree.right[node];
    }
    return tree.value[node];
  }

  /**
   * Mean positive-class probability across all trees, which is exactly what
   * RandomForestClassifier.predict_proba computes.
   * @param {number[]} features ordered as this.featureNames
   * @returns {number} risk score in [0, 1]
   */
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
    for (let t = 0; t < this.trees.length; t += 1) {
      total += RandomForest.scoreTree(this.trees[t], features);
    }
    return total / this.trees.length;
  }

  /** Convenience wrapper returning a labelled result object. */
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
