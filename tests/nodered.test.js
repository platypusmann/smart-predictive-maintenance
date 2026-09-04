'use strict';

/**
 * The Node-RED function node has its own inlined copy of the feature logic,
 * because function nodes cannot require project modules. That duplication is a
 * real risk: if the two drift apart, the edge would send the model feature
 * vectors computed differently from the ones it was trained on, and nothing
 * would visibly break. These tests execute the actual function node source in a
 * simulated Node-RED context and compare against the shared implementation.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { extractFeatures, featureNames } = require('@pdm/shared');

const NODE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../node-red/function-nodes/window-features.js'),
  'utf8'
);

/** Run the function node body the way Node-RED does, with its own context. */
function makeNode() {
  const store = new Map();
  const context = {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
  };
  const warnings = [];
  const statuses = [];
  const node = {
    warn: (msg) => warnings.push(msg),
    status: (s) => statuses.push(s),
    error: (msg) => warnings.push(msg),
  };

  return {
    warnings,
    statuses,
    send(payload) {
      const msg = { payload };
      const sandbox = { msg, context, node, console, Number, Math, Infinity };
      // Node-RED wraps the function body, so the source's bare `return` is legal.
      const script = new vm.Script(`(function () { ${NODE_SOURCE} })()`);
      return script.runInNewContext(sandbox);
    },
  };
}

function reading(index, machineId = 'M-0001') {
  return {
    machineId,
    machineType: 'pump',
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    runtimeHours: index / 3600,
    vibration: 2.5 + index * 0.01,
    temperature: 55 + index * 0.05,
    current: 12 + index * 0.02,
    rpm: 1450 - index * 0.3,
  };
}

test('the function node drops readings with no machineId', () => {
  const node = makeNode();
  assert.strictEqual(node.send({ vibration: 1 }), null);
  assert.strictEqual(node.warnings.length, 1);
});

test('the function node emits nothing until the window is full', () => {
  const node = makeNode();
  for (let i = 0; i < 29; i += 1) {
    assert.strictEqual(node.send(reading(i)), null, `emitted early at ${i}`);
  }
  assert.ok(node.send(reading(29)), 'should emit on the 30th reading');
});

test('the function node output matches the shared feature module exactly', () => {
  const node = makeNode();
  const window = [];

  let emitted = null;
  for (let i = 0; i < 30; i += 1) {
    const r = reading(i);
    window.push(r);
    emitted = node.send(r);
  }

  assert.ok(emitted, 'expected an emission on the 30th reading');

  const expected = extractFeatures(window, window[29].runtimeHours);
  assert.strictEqual(emitted.payload.features.length, featureNames().length);

  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(emitted.payload.features[i] - expected[i]) < 1e-12,
      `feature ${featureNames()[i]} differs: ` +
        `node-red ${emitted.payload.features[i]} vs shared ${expected[i]}`
    );
  }
});

test('the function node carries machine identity and raw values through', () => {
  const node = makeNode();
  let emitted = null;
  for (let i = 0; i < 30; i += 1) emitted = node.send(reading(i, 'M-0042'));

  assert.strictEqual(emitted.payload.machineId, 'M-0042');
  assert.strictEqual(emitted.payload.machineType, 'pump');
  assert.ok(Number.isFinite(emitted.payload.raw.vibration));
  assert.ok(Number.isFinite(emitted.payload.raw.rpm));
});

test('the function node keeps separate windows per machine', () => {
  const node = makeNode();
  // Interleave two machines; neither should reach 30 samples before the other.
  for (let i = 0; i < 29; i += 1) {
    node.send(reading(i, 'M-A'));
    node.send(reading(i, 'M-B'));
  }
  assert.ok(node.send(reading(29, 'M-A')), 'M-A should emit on its own 30th');
  assert.ok(node.send(reading(29, 'M-B')), 'M-B should emit on its own 30th');
});

test('flows.json stays in sync with the function node sources', () => {
  const flowsPath = path.resolve(__dirname, '../node-red/flows.json');
  if (!fs.existsSync(flowsPath)) {
    assert.fail('flows.json missing; run "npm run flows:build"');
  }
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const windowNode = flows.find((n) => n.id === 'fn-window-features');
  assert.ok(windowNode, 'flows.json should contain the windowing function node');
  assert.strictEqual(
    windowNode.func,
    NODE_SOURCE,
    'flows.json is stale; run "npm run flows:build"'
  );
});
