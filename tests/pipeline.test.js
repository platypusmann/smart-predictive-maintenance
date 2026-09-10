'use strict';

// Runs one simulated machine through the pipeline in a single process
// (rolling window -> features -> model -> alert policy) and checks that a
// work order gets raised before the machine fails. Needs the trained model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { RollingWindow, RandomForest, AlertPolicy } = require('@pdm/shared');
const { SimulatedMachine } = require('../services/simulator/src/machine');

const MODEL_PATH = path.resolve(__dirname, '../ml/artifacts/model.json');

test('a degrading machine is flagged before it fails', { skip: !fs.existsSync(MODEL_PATH) }, () => {
  const forest = RandomForest.fromFile(MODEL_PATH);
  const policy = new AlertPolicy({ threshold: 0.7, consecutiveBreaches: 3 });
  const window = new RollingWindow({ size: 30, stride: 10 });
  const machine = new SimulatedMachine({ id: 'TEST-1', type: 'pump', seed: 20250901, timeScale: 1 });

  let alertAt = null;
  // one tick = one simulated second, until it fails or we raise an alert
  while (!machine.failed && alertAt === null) {
    const emitted = window.push(machine.tick(1));
    if (!emitted) continue;

    const { riskScore } = forest.score(emitted.features);
    const decision = policy.evaluate(machine.id, riskScore, machine.simSeconds * 1000);
    if (decision.action === 'raise') alertAt = machine.simSeconds;
  }

  assert.ok(alertAt !== null, 'no work order was raised');
  assert.ok(alertAt > machine.faultOnsetSeconds, 'alert was raised before the fault started');
  assert.ok(alertAt < machine.lifeSeconds, 'alert was raised after the machine failed');
});
