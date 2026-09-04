'use strict';

/**
 * Work-order decision policy.
 *
 * Kept as a pure, dependency-free class so it can be unit tested exhaustively
 * without a broker or a database. A single window crossing the risk threshold
 * is not enough to raise a work order: the machine must breach on N consecutive
 * windows, and a machine that has just been alerted on is muted for a cooldown
 * period so one degrading machine does not generate a stream of duplicates.
 */

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

  /**
   * Feed one prediction in and find out what to do about it.
   *
   * @param {string} machineId
   * @param {number} riskScore  model output in [0, 1]
   * @param {number} now        epoch millis, injectable for deterministic tests
   * @returns {{action: 'none'|'raise'|'suppressed', streak: number, reason: string}}
   */
  evaluate(machineId, riskScore, now = Date.now()) {
    const state = this.getState(machineId);

    if (riskScore < this.threshold) {
      // Recovery resets the streak, so intermittent noise never accumulates
      // into an alert across unrelated windows.
      state.streak = 0;
      return { action: 'none', streak: 0, reason: 'below_threshold' };
    }

    state.streak += 1;

    if (state.streak < this.consecutiveBreaches) {
      return {
        action: 'none',
        streak: state.streak,
        reason: 'awaiting_confirmation',
      };
    }

    const sinceLastAlert = now - state.lastAlertAt;
    if (state.lastAlertAt > 0 && sinceLastAlert < this.cooldownMs) {
      return { action: 'suppressed', streak: state.streak, reason: 'cooldown' };
    }

    state.lastAlertAt = now;
    // Reset so the next work order also requires a fresh confirmed streak.
    state.streak = 0;
    return { action: 'raise', streak: this.consecutiveBreaches, reason: 'confirmed' };
  }

  /** Number of machines currently being tracked, exposed on /metrics. */
  trackedMachines() {
    return this.state.size;
  }
}

module.exports = { AlertPolicy };
