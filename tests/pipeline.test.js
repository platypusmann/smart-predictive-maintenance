'use strict';

/**
 * Pipeline integration test.
 *
 * Runs simulated machines through the exact chain the deployed system uses
 * (rolling window -> feature extraction -> forest scoring -> alert policy) in a
 * single deterministic process, with no broker or database involved.
 *
 * The unit tests prove each stage works alone and the smoke test proves the
 * services are wired together. This fills the gap between them: it answers the
 * question the project actually exists to answer, which is whether a degrading
 * machine gets flagged with enough warning to be useful, and whether healthy
 * machines are left alone.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { RollingWindow, RandomForest, AlertPolicy } = require('@pdm/shared');
const { SimulatedMachine } = require('../services/simulator/src/machine');

const MODEL_PATH = path.resolve(__dirname, '../ml/artifacts/model.json');
const hasModel = fs.existsSync(MODEL_PATH);

const RISK_THRESHOLD = 0.7;
const CONSECUTIVE_BREACHES = 3;

/**
 * Push one machine's whole life through the pipeline.
 * Returns when the first work order is raised, or when the machine fails.
 */
function runMachineToFailure(machine, forest, policy) {
  const window = new RollingWindow({ size: 30, stride: 10 });

  let firstAlertAtSeconds = null;
  let peakRisk = 0;
  let windowsScored = 0;
  let breaches = 0;

  // One tick per simulated second, capped so a test can never hang.
  for (let tick = 0; tick < 200000; tick += 1) {
    const reading = machine.tick(1);
    const emitted = window.push(reading);

    if (emitted) {
      const { riskScore } = forest.score(emitted.features, RISK_THRESHOLD);
      windowsScored += 1;
      peakRisk = Math.max(peakRisk, riskScore);
      if (riskScore >= RISK_THRESHOLD) breaches += 1;

      if (firstAlertAtSeconds === null) {
        const decision = policy.evaluate(machine.id, riskScore, tick * 1000);
        if (decision.action === 'raise') {
          firstAlertAtSeconds = machine.simSeconds;
        }
      }
    }

    if (machine.failed) break;
  }

  return {
    firstAlertAtSeconds,
    failureAtSeconds: machine.lifeSeconds,
    faultOnsetSeconds: machine.faultOnsetSeconds,
    leadTimeSeconds:
      firstAlertAtSeconds === null ? null : machine.lifeSeconds - firstAlertAtSeconds,
    peakRisk,
    windowsScored,
    breaches,
  };
}

function newPolicy() {
  return new AlertPolicy({
    threshold: RISK_THRESHOLD,
    consecutiveBreaches: CONSECUTIVE_BREACHES,
    // Only the first alert per machine matters here.
    cooldownMs: Number.MAX_SAFE_INTEGER,
  });
}

test('a degrading machine is flagged before it fails', { skip: !hasModel }, () => {
  const forest = RandomForest.fromFile(MODEL_PATH);
  const machine = new SimulatedMachine({
    id: 'IT-0001',
    type: 'pump',
    seed: 20250901,
    timeScale: 1, // one simulated second per tick, so timings are readable
  });

  const result = runMachineToFailure(machine, forest, newPolicy());

  assert.notStrictEqual(
    result.firstAlertAtSeconds,
    null,
    'the pipeline never raised a work order for a machine that ran to failure'
  );
  assert.ok(
    result.firstAlertAtSeconds > result.faultOnsetSeconds,
    'alert fired before the fault was even seeded, which would indicate leakage'
  );
  assert.ok(
    result.leadTimeSeconds > 0,
    'the work order must be raised before the failure, not after'
  );
});

test('healthy machines do not generate work orders', { skip: !hasModel }, () => {
  const forest = RandomForest.fromFile(MODEL_PATH);
  const policy = newPolicy();
  const window = new RollingWindow({ size: 30, stride: 10 });

  const machine = new SimulatedMachine({
    id: 'IT-HEALTHY',
    type: 'compressor',
    seed: 555,
    timeScale: 1,
    forceHealthy: true,
  });

  let alerts = 0;
  // Six simulated hours of a machine that never develops a fault.
  for (let tick = 0; tick < 6 * 3600; tick += 1) {
    const emitted = window.push(machine.tick(1));
    if (!emitted) continue;
    const { riskScore } = forest.score(emitted.features, RISK_THRESHOLD);
    if (policy.evaluate(machine.id, riskScore, tick * 1000).action === 'raise') {
      alerts += 1;
    }
  }

  assert.strictEqual(alerts, 0, `healthy machine raised ${alerts} false work orders`);
});

test('early warning holds across a mixed fleet', { skip: !hasModel }, () => {
  const forest = RandomForest.fromFile(MODEL_PATH);
  const types = ['pump', 'compressor', 'conveyor'];

  const detected = [];
  const missed = [];

  // A fleet spanning all three machine types and a range of degradation curves.
  for (let i = 0; i < 18; i += 1) {
    const machine = new SimulatedMachine({
      id: `IT-${String(i + 1).padStart(3, '0')}`,
      type: types[i % types.length],
      seed: 90210 + i * 7919,
      timeScale: 1,
    });
    const result = runMachineToFailure(machine, forest, newPolicy());
    if (result.firstAlertAtSeconds === null) missed.push(result);
    else detected.push(result);
  }

  const total = detected.length + missed.length;
  const leadTimes = detected.map((r) => r.leadTimeSeconds).sort((a, b) => a - b);
  const median = leadTimes[Math.floor(leadTimes.length / 2)] || 0;

  // Reported so the numbers can be quoted in the project status document.
  console.log(
    `\n  fleet detection: ${detected.length}/${total} machines flagged before failure`
  );
  console.log(
    `  lead time (minutes): min ${(leadTimes[0] / 60).toFixed(1)}, ` +
    `median ${(median / 60).toFixed(1)}, ` +
    `max ${(leadTimes.at(-1) / 60).toFixed(1)}\n`
  );

  assert.ok(
    detected.length / total >= 0.9,
    `only ${detected.length}/${total} degrading machines were detected before failure`
  );
  assert.ok(
    median > 60,
    `median warning of ${median}s is too short to act on`
  );
});
