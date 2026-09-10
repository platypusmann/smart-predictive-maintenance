'use strict';

// Decides when to raise a work order. A machine has to be over the threshold
// for a few windows in a row, and after an alert it's muted for a cooldown so
// we don't get a pile of duplicate work orders.

class AlertPolicy {
  constructor({ threshold = 0.7, consecutiveBreaches = 3, cooldownMs = 900000 } = {}) {
    this.threshold = threshold;
    this.consecutiveBreaches = consecutiveBreaches;
    this.cooldownMs = cooldownMs;
    this.state = new Map(); // machineId -> { streak, lastAlertAt }
  }

  getState(machineId) {
    if (!this.state.has(machineId)) {
      this.state.set(machineId, { streak: 0, lastAlertAt: 0 });
    }
    return this.state.get(machineId);
  }

  // returns { action: 'none' | 'raise' | 'suppressed', streak, reason }
  evaluate(machineId, riskScore, now = Date.now()) {
    const state = this.getState(machineId);

    if (riskScore < this.threshold) {
      state.streak = 0;
      return { action: 'none', streak: 0, reason: 'below_threshold' };
    }

    state.streak += 1;

    if (state.streak < this.consecutiveBreaches) {
      return { action: 'none', streak: state.streak, reason: 'awaiting_confirmation' };
    }

    if (state.lastAlertAt > 0 && now - state.lastAlertAt < this.cooldownMs) {
      return { action: 'suppressed', streak: state.streak, reason: 'cooldown' };
    }

    state.lastAlertAt = now;
    state.streak = 0;
    return { action: 'raise', streak: this.consecutiveBreaches, reason: 'confirmed' };
  }

  trackedMachines() {
    return this.state.size;
  }
}

module.exports = { AlertPolicy };
