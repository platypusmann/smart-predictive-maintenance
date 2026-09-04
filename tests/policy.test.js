'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AlertPolicy } = require('@pdm/shared');

const OPTIONS = { threshold: 0.7, consecutiveBreaches: 3, cooldownMs: 60000 };

test('a single breach does not raise a work order', () => {
  const policy = new AlertPolicy(OPTIONS);
  const decision = policy.evaluate('M-1', 0.95, 1000);
  assert.strictEqual(decision.action, 'none');
  assert.strictEqual(decision.reason, 'awaiting_confirmation');
  assert.strictEqual(decision.streak, 1);
});

test('three consecutive breaches raise exactly one work order', () => {
  const policy = new AlertPolicy(OPTIONS);
  assert.strictEqual(policy.evaluate('M-1', 0.8, 1000).action, 'none');
  assert.strictEqual(policy.evaluate('M-1', 0.85, 2000).action, 'none');

  const raised = policy.evaluate('M-1', 0.9, 3000);
  assert.strictEqual(raised.action, 'raise');
  assert.strictEqual(raised.reason, 'confirmed');
});

test('a healthy reading resets the streak', () => {
  const policy = new AlertPolicy(OPTIONS);
  policy.evaluate('M-1', 0.8, 1000);
  policy.evaluate('M-1', 0.85, 2000);

  const recovered = policy.evaluate('M-1', 0.2, 3000);
  assert.strictEqual(recovered.action, 'none');
  assert.strictEqual(recovered.streak, 0);

  // The streak restarts from scratch, so two more breaches are still not enough.
  assert.strictEqual(policy.evaluate('M-1', 0.9, 4000).action, 'none');
  assert.strictEqual(policy.evaluate('M-1', 0.9, 5000).action, 'none');
  assert.strictEqual(policy.evaluate('M-1', 0.9, 6000).action, 'raise');
});

test('further breaches inside the cooldown are suppressed', () => {
  const policy = new AlertPolicy(OPTIONS);
  for (let i = 0; i < 3; i += 1) policy.evaluate('M-1', 0.9, 1000 + i);

  // Confirm another streak while still inside the 60s cooldown.
  policy.evaluate('M-1', 0.9, 2000);
  policy.evaluate('M-1', 0.9, 3000);
  const suppressed = policy.evaluate('M-1', 0.9, 4000);

  assert.strictEqual(suppressed.action, 'suppressed');
  assert.strictEqual(suppressed.reason, 'cooldown');
});

test('a work order can be raised again once the cooldown expires', () => {
  const policy = new AlertPolicy(OPTIONS);
  for (let i = 0; i < 3; i += 1) policy.evaluate('M-1', 0.9, 1000 + i);

  const later = 1000 + OPTIONS.cooldownMs + 1;
  policy.evaluate('M-1', 0.9, later);
  policy.evaluate('M-1', 0.9, later + 1);
  const raised = policy.evaluate('M-1', 0.9, later + 2);

  assert.strictEqual(raised.action, 'raise');
});

test('machines are tracked independently of one another', () => {
  const policy = new AlertPolicy(OPTIONS);
  policy.evaluate('M-1', 0.9, 1000);
  policy.evaluate('M-2', 0.9, 1000);
  policy.evaluate('M-1', 0.9, 2000);

  // M-1 is on its third breach, M-2 only its second.
  assert.strictEqual(policy.evaluate('M-1', 0.9, 3000).action, 'raise');
  assert.strictEqual(policy.evaluate('M-2', 0.9, 3000).action, 'none');
  assert.strictEqual(policy.trackedMachines(), 2);
});

test('scores exactly at the threshold count as a breach', () => {
  const policy = new AlertPolicy({ ...OPTIONS, consecutiveBreaches: 1 });
  assert.strictEqual(policy.evaluate('M-1', 0.7, 1000).action, 'raise');
});
