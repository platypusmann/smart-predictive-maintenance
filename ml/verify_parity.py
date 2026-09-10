"""
Sanity check that the Node.js version of the model (features.js + forest.js)
gives the same answers as the Python/sklearn version, on a few example windows.

Usage: python verify_parity.py   (run train_model.py first)
"""

import json
import math
import os
import subprocess
import sys

import joblib

from features import extract_features

HERE = os.path.dirname(os.path.abspath(__file__))
TOLERANCE = 0.01

# name, vibration, temperature, current, rpm, runtime hours, drift across the window
CASES = [
    ("healthy pump", 2.5, 55.0, 12.0, 1450, 1.0, 0.0),
    ("healthy compressor", 3.2, 62.0, 18.0, 2900, 2.0, 0.0),
    ("healthy conveyor", 1.8, 45.0, 8.0, 900, 0.5, 0.0),
    ("brand new pump", 2.5, 55.0, 12.0, 1450, 0.0, 0.0),
    ("old compressor, still ok", 3.2, 62.0, 18.0, 2900, 11.0, 0.0),
    ("pump starting to wear", 3.5, 60.0, 13.5, 1420, 5.0, 0.02),
    ("compressor starting to wear", 4.0, 68.0, 20.0, 2850, 4.0, 0.02),
    ("conveyor starting to wear", 2.6, 50.0, 9.5, 870, 3.0, 0.02),
    ("pump about to fail", 6.5, 76.0, 18.0, 1280, 8.0, 0.05),
    ("compressor about to fail", 7.2, 84.0, 24.5, 2720, 9.0, 0.05),
    ("conveyor about to fail", 5.9, 67.0, 14.5, 720, 7.5, 0.05),
    ("hot but cooling down", 4.5, 70.0, 15.0, 1400, 6.0, -0.03),
]


def make_window(vibration, temperature, current, rpm, drift, size=30):
    base = {"vibration": vibration, "temperature": temperature, "current": current, "rpm": rpm}
    window = []
    for i in range(size):
        # a small wobble so std isn't 0, plus the drift
        factor = 1 + drift * i / size + 0.01 * math.sin(i)
        window.append({ch: value * factor for ch, value in base.items()})
    return window


def main():
    model_path = os.path.join(HERE, "artifacts", "model.joblib")
    if not os.path.exists(model_path):
        print("No model found, run train_model.py first")
        return 1
    model = joblib.load(model_path)

    cases = []
    for name, vib, temp, cur, rpm, hours, drift in CASES:
        cases.append({
            "name": name,
            "window": make_window(vib, temp, cur, rpm, drift),
            "runtimeHours": hours,
        })

    py_features = [extract_features(c["window"], c["runtimeHours"]) for c in cases]
    py_scores = model.predict_proba(py_features)[:, 1]

    # run the same windows through the JS code
    proc = subprocess.run(
        ["node", os.path.join(HERE, "parity_node.js")],
        input=json.dumps({"cases": cases}),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print("parity_node.js failed:")
        print(proc.stderr)
        return 1
    js = json.loads(proc.stdout)

    failures = 0
    for i, case in enumerate(cases):
        feature_diff = max(abs(a - b) for a, b in zip(py_features[i], js["features"][i]))
        score_diff = abs(py_scores[i] - js["scores"][i])
        ok = feature_diff < TOLERANCE and score_diff < TOLERANCE
        if not ok:
            failures += 1
        print(f"{case['name']:<30} python {py_scores[i]:.3f}   js {js['scores'][i]:.3f}   {'ok' if ok else 'MISMATCH'}")

    if failures:
        print(f"\nFAIL: {failures} of {len(cases)} cases didn't match")
        return 1

    print(f"\nPASS: all {len(cases)} cases match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
