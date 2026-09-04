"""
Generate a synthetic run-to-failure dataset for the predictive maintenance model.

Each simulated machine runs from healthy until failure. A fault is seeded at a
random point in its life and then grows, pushing vibration, temperature and
current draw away from their healthy baselines while RPM sags under load.

Windows are labelled positive when the machine fails within FAILURE_HORIZON_S
seconds of the end of the window, which is exactly the question the deployed
model is asked at inference time: "is this machine about to fail?".

The same degradation physics are implemented in services/simulator so the live
simulated fleet produces data drawn from the same distribution the model was
trained on.

Usage:
    python generate_dataset.py --machines 400 --out artifacts/dataset.csv
"""

import argparse
import csv
import os
import random

from features import CHANNELS, extract_features, feature_names

SAMPLE_INTERVAL_S = 1.0     # one raw reading per second per machine
WINDOW_SIZE = 30            # 30 readings == 30 s rolling window
WINDOW_STRIDE = 10          # emit a feature vector every 10 s
FAILURE_HORIZON_S = 600     # label positive if failure occurs within 10 minutes

MACHINE_TYPES = {
    "pump":      {"vibration": 2.5, "temperature": 55.0, "current": 12.0, "rpm": 1450.0},
    "compressor": {"vibration": 3.2, "temperature": 62.0, "current": 18.0, "rpm": 2900.0},
    "conveyor":  {"vibration": 1.8, "temperature": 45.0, "current": 8.0, "rpm": 900.0},
}

NOISE = {"vibration": 0.12, "temperature": 0.45, "current": 0.25, "rpm": 6.0}

# How strongly a fault of severity 1.0 shifts each channel from baseline.
FAULT_GAIN = {"vibration": 4.2, "temperature": 22.0, "current": 6.5, "rpm": -180.0}


def simulate_machine(rng, machine_type):
    """Produce the full raw reading history for one machine, run to failure."""
    baseline = MACHINE_TYPES[machine_type]

    life_s = rng.randint(3 * 3600, 10 * 3600)          # 3 to 10 hours of life
    fault_onset_s = rng.randint(int(life_s * 0.35), int(life_s * 0.8))
    # Exponent < 1 degrades early and gently, > 1 stays flat then collapses.
    shape = rng.uniform(1.4, 3.2)

    readings = []
    t = 0.0
    while t < life_s:
        if t < fault_onset_s:
            severity = 0.0
        else:
            progress = (t - fault_onset_s) / max(life_s - fault_onset_s, 1.0)
            severity = progress ** shape

        reading = {"t": t, "runtime_hours": t / 3600.0}
        for ch in CHANNELS:
            value = baseline[ch] + FAULT_GAIN[ch] * severity
            value += rng.gauss(0.0, NOISE[ch])
            reading[ch] = value
        readings.append(reading)
        t += SAMPLE_INTERVAL_S

    return readings, life_s


def windows_from_readings(readings, life_s):
    """Slide a window over the raw history and label each resulting vector."""
    rows = []
    for end in range(WINDOW_SIZE, len(readings) + 1, WINDOW_STRIDE):
        window = readings[end - WINDOW_SIZE:end]
        last = window[-1]
        vector = extract_features(window, last["runtime_hours"])
        time_to_failure = life_s - last["t"]
        label = 1 if time_to_failure <= FAILURE_HORIZON_S else 0
        rows.append((vector, label, time_to_failure))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--machines", type=int, default=400)
    parser.add_argument("--seed", type=int, default=314)
    parser.add_argument("--out", default="artifacts/dataset.csv")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    types = list(MACHINE_TYPES.keys())

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    columns = feature_names() + ["machine_type", "time_to_failure_s", "label"]

    positives = 0
    total = 0
    with open(args.out, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for i in range(args.machines):
            machine_type = types[i % len(types)]
            readings, life_s = simulate_machine(rng, machine_type)
            for vector, label, ttf in windows_from_readings(readings, life_s):
                writer.writerow(
                    [f"{v:.6f}" for v in vector] + [machine_type, f"{ttf:.1f}", label]
                )
                positives += label
                total += 1
            if (i + 1) % 50 == 0:
                print(f"  simulated {i + 1}/{args.machines} machines")

    print(f"\nWrote {total} windows to {args.out}")
    print(f"Positive (failure within {FAILURE_HORIZON_S}s): {positives} "
          f"({positives / total:.1%})")


if __name__ == "__main__":
    main()
