'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const NODE_RED = path.resolve(__dirname, '../node-red');

// ignore windows vs linux line endings
const normalise = (text) => text.replace(/\r\n/g, '\n');

// flows.json is generated from function-nodes/, check it's been rebuilt
test('flows.json is up to date with function-nodes/', () => {
  const flows = JSON.parse(fs.readFileSync(path.join(NODE_RED, 'flows.json'), 'utf8'));

  const nodes = { 'fn-window-features': 'window-features.js', 'fn-batch-post': 'batch-and-post.js' };
  for (const [id, file] of Object.entries(nodes)) {
    const source = fs.readFileSync(path.join(NODE_RED, 'function-nodes', file), 'utf8');
    const node = flows.find((n) => n.id === id);
    assert.strictEqual(normalise(node.func), normalise(source), `${file} changed, run "npm run flows:build"`);
  }
});
