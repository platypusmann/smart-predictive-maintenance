"""
Train the failure-risk classifier and export it in two formats:

  artifacts/model.joblib  - native scikit-learn model, used for offline analysis
  artifacts/model.json    - portable export consumed by the Node.js inference
                            microservice (see packages/shared/src/forest.js)

The JSON export exists so the inference microservice can stay a pure Node.js
service, as the unit requires, without shipping a Python runtime or a native
ONNX dependency into the container. Every tree is exported as flat arrays and
the JS scorer walks them directly, which is exact rather than approximate.
`verify_parity.py` proves the two implementations agree.

Usage:
    python train_model.py --data artifacts/dataset.csv
"""

import argparse
import json
import os

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    average_precision_score,
    classification_report,
    confusion_matrix,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split

from features import feature_names


def export_forest(model, names, metadata):
    """Flatten a fitted RandomForestClassifier into plain JSON."""
    trees = []
    for estimator in model.estimators_:
        t = estimator.tree_
        # value[:, 0, :] holds per-class sample counts at each node.
        counts = t.value[:, 0, :]
        totals = counts.sum(axis=1, keepdims=True)
        totals[totals == 0] = 1.0
        proba = counts / totals
        trees.append({
            "feature": t.feature.astype(int).tolist(),
            "threshold": t.threshold.astype(float).tolist(),
            "left": t.children_left.astype(int).tolist(),
            "right": t.children_right.astype(int).tolist(),
            # Probability of the positive class at each node.
            "value": [float(p) for p in proba[:, 1]],
        })

    return {
        "format": "pdm-random-forest-v1",
        "featureNames": names,
        "nClasses": int(model.n_classes_),
        "positiveClassIndex": 1,
        "trees": trees,
        "metadata": metadata,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="artifacts/dataset.csv")
    parser.add_argument("--outdir", default="artifacts")
    parser.add_argument("--trees", type=int, default=60)
    parser.add_argument("--max-depth", type=int, default=10)
    parser.add_argument("--seed", type=int, default=314)
    args = parser.parse_args()

    names = feature_names()
    frame = pd.read_csv(args.data)
    X = frame[names].to_numpy(dtype=np.float64)
    y = frame["label"].to_numpy(dtype=int)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=args.seed, stratify=y
    )

    model = RandomForestClassifier(
        n_estimators=args.trees,
        max_depth=args.max_depth,
        min_samples_leaf=5,
        class_weight="balanced",
        random_state=args.seed,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    proba = model.predict_proba(X_test)[:, 1]
    pred = (proba >= 0.5).astype(int)

    roc = roc_auc_score(y_test, proba)
    ap = average_precision_score(y_test, proba)

    print("\n=== Held-out test performance ===")
    print(f"ROC AUC            : {roc:.4f}")
    print(f"Average precision  : {ap:.4f}")
    print("\nConfusion matrix (rows = actual, cols = predicted):")
    print(confusion_matrix(y_test, pred))
    print("\n" + classification_report(y_test, pred, digits=4,
                                       target_names=["healthy", "failing"]))

    # Threshold sweep. The default 0.5 cut maximises recall but raises far too
    # many false positives to put in front of a technician. This table is what
    # RISK_THRESHOLD in the running services is chosen from.
    print("Threshold sweep (before the alerting service's confirmation streak):")
    print(f"  {'thr':>5} {'precision':>10} {'recall':>8} {'F1':>8} {'alerts/1k':>10}")
    sweep = []
    for thr in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
        flagged = (proba >= thr).astype(int)
        tp = int(((flagged == 1) & (y_test == 1)).sum())
        fp = int(((flagged == 1) & (y_test == 0)).sum())
        fn = int(((flagged == 0) & (y_test == 1)).sum())
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        rate = 1000 * (tp + fp) / len(y_test)
        print(f"  {thr:>5.1f} {precision:>10.4f} {recall:>8.4f} {f1:>8.4f} {rate:>10.1f}")
        sweep.append({
            "threshold": thr,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "alertsPerThousandWindows": round(rate, 1),
        })
    print()

    importances = sorted(
        zip(names, model.feature_importances_), key=lambda kv: -kv[1]
    )
    print("Top 8 features by importance:")
    for name, importance in importances[:8]:
        print(f"  {name:<24} {importance:.4f}")

    os.makedirs(args.outdir, exist_ok=True)
    joblib.dump(model, os.path.join(args.outdir, "model.joblib"))

    metadata = {
        "modelVersion": "1.0.0",
        "algorithm": "RandomForestClassifier",
        "nEstimators": args.trees,
        "maxDepth": args.max_depth,
        "trainingRows": int(len(X_train)),
        "testRows": int(len(X_test)),
        "rocAuc": round(float(roc), 4),
        "averagePrecision": round(float(ap), 4),
        "thresholdSweep": sweep,
    }

    export = export_forest(model, names, metadata)
    json_path = os.path.join(args.outdir, "model.json")
    with open(json_path, "w") as handle:
        json.dump(export, handle)

    size_kb = os.path.getsize(json_path) / 1024
    print(f"\nSaved artifacts/model.joblib and {json_path} ({size_kb:.0f} KB)")

    with open(os.path.join(args.outdir, "metrics.json"), "w") as handle:
        json.dump(metadata, handle, indent=2)


if __name__ == "__main__":
    main()
