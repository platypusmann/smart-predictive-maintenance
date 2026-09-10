"""
Feature extraction for the model. Has to match packages/shared/src/features.js
(npm run ml:parity checks this).
"""

import numpy as np

CHANNELS = ["vibration", "temperature", "current", "rpm"]
STATS = ["mean", "std", "min", "max", "slope"]


def feature_names():
    names = []
    for ch in CHANNELS:
        for st in STATS:
            names.append(f"{ch}_{st}")
    names.append("runtime_hours")
    return names


def _slope(values):
    # least squares slope against x = 0..n-1
    n = len(values)
    if n < 2:
        return 0.0
    x = np.arange(n, dtype=np.float64)
    y = np.asarray(values, dtype=np.float64)
    x_mean = x.mean()
    y_mean = y.mean()
    denom = ((x - x_mean) ** 2).sum()
    if denom == 0:
        return 0.0
    return float(((x - x_mean) * (y - y_mean)).sum() / denom)


def extract_features(window, runtime_hours):
    # window is a list of readings (dicts), returns a list in feature_names() order
    vector = []
    for ch in CHANNELS:
        series = np.asarray([float(r[ch]) for r in window], dtype=np.float64)
        vector.append(float(series.mean()))
        vector.append(float(series.std()))  # population std (ddof=0)
        vector.append(float(series.min()))
        vector.append(float(series.max()))
        vector.append(_slope(series))
    vector.append(float(runtime_hours))
    return vector
