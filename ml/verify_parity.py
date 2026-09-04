"""
Prove that the Node.js inference path reproduces scikit-learn exactly.

The deployed model is not the .joblib file: it is the JSON export scored by
packages/shared/src/forest.js. That means "the model scored 0.97 in testing" is
only a meaningful claim about the running system if the JS implementation
agrees with the Python one. This script checks two things on random windows:

  1. feature parity  - ml/features.py and features.js produce identical vectors
  2. score parity    - the JS forest and RandomForestClassifier.predict_proba
                       produce identical probabilities

Exit code is non-zero if either check fails, so it can gate a deployment.

Usage:
    python verify_parity.py --cases 500
"""

import argparse
import json
import random
import subprocess
import sys
import os

import joblib
import numpy as np

from features import CHANNELS, extract_features

HERE = os.path.dirname(os.path.abspath(__file__))

# Tolerances. Both sides do the same arithmetic in IEEE-754 doubles, so the only
# expected difference is floating point summation order.
FEATURE_TOLERANCE = 1e-9
SCORE_TOLERANCE = 1e-12


def random_window(rng, size=30):
    """A window of plausible but deliberately varied sensor readings."""
    base = {
        "vibration": rng.uniform(1.0, 9.0),
        "temperature": rng.uniform(35.0, 95.0),
        "current": rng.uniform(5.0, 28.0),
        "rpm": rng.uniform(700.0, 3100.0),
    }
    drift = {ch: rng.uniform(-0.05, 0.15) * base[ch] for ch in CHANNELS}

    window = []
    for i in range(size):
        reading = {}
        for ch in CHANNELS:
            reading[ch] = base[ch] + drift[ch] * i / size + rng.gauss(0, base[ch] * 0.02)
        window.append(reading)
    return window


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=int, default=500)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    model_json = os.path.join(HERE, "artifacts", "model.json")
    model_joblib = os.path.join(HERE, "artifacts", "model.joblib")
    for path in (model_json, model_joblib):
        if not os.path.exists(path):
            print(f"Missing {path}. Run train_model.py first.")
            return 1

    rng = random.Random(args.seed)
    cases = []
    for _ in range(args.cases):
        window = random_window(rng)
        cases.append({"window": window, "runtimeHours": rng.uniform(0, 12)})

    # --- Python side -----------------------------------------------------
    py_features = np.array(
        [extract_features(c["window"], c["runtimeHours"]) for c in cases],
        dtype=np.float64,
    )
    model = joblib.load(model_joblib)
    py_scores = model.predict_proba(py_features)[:, 1]

    # --- Node side -------------------------------------------------------
    print(f"Running {args.cases} cases through the Node.js implementation...")
    proc = subprocess.run(
        ["node", os.path.join(HERE, "parity_node.js")],
        input=json.dumps({"cases": cases}),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print("Node parity harness failed:")
        print(proc.stderr)
        return 1

    node_output = json.loads(proc.stdout)
    node_features = np.array(node_output["features"], dtype=np.float64)
    node_scores = np.array(node_output["scores"], dtype=np.float64)

    # --- Compare ---------------------------------------------------------
    feature_diff = np.abs(py_features - node_features)
    score_diff = np.abs(py_scores - node_scores)

    max_feature_diff = float(feature_diff.max())
    max_score_diff = float(score_diff.max())

    print("\n=== Parity report ===")
    print(f"Cases compared            : {args.cases}")
    print(f"Features per case         : {py_features.shape[1]}")
    print(f"Max feature difference    : {max_feature_diff:.3e}  (tol {FEATURE_TOLERANCE:.0e})")
    print(f"Max score difference      : {max_score_diff:.3e}  (tol {SCORE_TOLERANCE:.0e})")
    print(f"Exact score matches       : {int((score_diff == 0).sum())}/{args.cases}")

    ok = True
    if max_feature_diff > FEATURE_TOLERANCE:
        worst = int(np.unravel_index(feature_diff.argmax(), feature_diff.shape)[1])
        print(f"\nFEATURE PARITY FAILED (worst feature index {worst})")
        ok = False
    if max_score_diff > SCORE_TOLERANCE:
        print("\nSCORE PARITY FAILED")
        ok = False

    if ok:
        print("\nPASS: the Node.js inference path reproduces scikit-learn.")
        return 0

    print("\nFAIL: implementations have diverged. Do not deploy this model.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
