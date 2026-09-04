"""
Canonical feature definition for the predictive maintenance model.

IMPORTANT: this file and packages/shared/src/features.js MUST stay in sync.
tests/parity are used to prove that both implementations produce identical
feature vectors for the same input window. If you change a statistic here,
change it there too and re-run `npm run verify:parity`.
"""

import numpy as np

# Raw sensor channels captured from each machine, in a fixed order.
CHANNELS = ["vibration", "temperature", "current", "rpm"]

# Statistics computed per channel over a rolling window.
STATS = ["mean", "std", "min", "max", "slope"]


def feature_names():
    """Canonical, ordered list of feature names."""
    names = []
    for ch in CHANNELS:
        for st in STATS:
            names.append(f"{ch}_{st}")
    names.append("runtime_hours")
    return names


def _slope(values):
    """
    Least-squares slope of `values` against the index 0..n-1.

    Uses the closed-form solution so that the JS implementation can reproduce
    it exactly without a linear algebra library.
    """
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
    """
    Turn a window of raw readings into an ordered feature vector.

    `window` is a list of dicts, each containing every key in CHANNELS.
    Returns a list[float] ordered exactly as feature_names().
    """
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
