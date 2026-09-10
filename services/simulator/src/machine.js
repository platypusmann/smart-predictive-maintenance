'use strict';

// Simulated machine. Uses the same numbers as ml/generate_dataset.py so the
// live data looks like the training data.

const MACHINE_TYPES = {
  pump: { vibration: 2.5, temperature: 55.0, current: 12.0, rpm: 1450.0 },
  compressor: { vibration: 3.2, temperature: 62.0, current: 18.0, rpm: 2900.0 },
  conveyor: { vibration: 1.8, temperature: 45.0, current: 8.0, rpm: 900.0 },
};

const NOISE = { vibration: 0.12, temperature: 0.45, current: 0.25, rpm: 6.0 };
const FAULT_GAIN = { vibration: 4.2, temperature: 22.0, current: 6.5, rpm: -180.0 };

// seeded random number generator (mulberry32) so runs are repeatable
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// gaussian noise (Box-Muller)
function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class SimulatedMachine {
  // timeScale > 1 speeds up the machine's life so it fails within a demo
  constructor({ id, type, seed, timeScale = 60, forceHealthy = false }) {
    if (!MACHINE_TYPES[type]) throw new Error(`Unknown machine type: ${type}`);

    this.id = id;
    this.type = type;
    this.baseline = MACHINE_TYPES[type];
    this.rand = mulberry32(seed);
    this.timeScale = timeScale;
    this.forceHealthy = forceHealthy;

    this.lifeSeconds = 3 * 3600 + Math.floor(this.rand() * 7 * 3600);
    this.faultOnsetSeconds = forceHealthy
      ? Infinity
      : Math.floor(this.lifeSeconds * (0.35 + this.rand() * 0.45));
    this.shape = 1.4 + this.rand() * 1.8;

    this.simSeconds = 0;
    this.failed = false;
  }

  get severity() {
    if (this.simSeconds < this.faultOnsetSeconds) return 0;
    const span = Math.max(this.lifeSeconds - this.faultOnsetSeconds, 1);
    const progress = (this.simSeconds - this.faultOnsetSeconds) / span;
    return Math.min(progress, 1.5) ** this.shape;
  }

  // move time forward one tick and return a reading
  tick(tickSeconds = 1) {
    this.simSeconds += tickSeconds * this.timeScale;

    const severity = this.severity;
    const reading = {
      machineId: this.id,
      machineType: this.type,
      timestamp: new Date().toISOString(),
      runtimeHours: this.simSeconds / 3600,
    };

    for (const channel of Object.keys(this.baseline)) {
      reading[channel] =
        this.baseline[channel] +
        FAULT_GAIN[channel] * severity +
        gaussian(this.rand) * NOISE[channel];
    }

    if (this.simSeconds >= this.lifeSeconds && !this.forceHealthy) {
      this.failed = true;
    }
    return reading;
  }

  // replace a failed machine with a new one of the same type
  reset(seed) {
    const replacement = new SimulatedMachine({
      id: this.id,
      type: this.type,
      seed,
      timeScale: this.timeScale,
      forceHealthy: this.forceHealthy,
    });
    Object.assign(this, replacement);
  }
}

module.exports = { SimulatedMachine, MACHINE_TYPES, NOISE, FAULT_GAIN };
