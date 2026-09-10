'use strict';

// Builds node-red/flows.json using the function node code in function-nodes/
// (much easier to edit them as normal .js files than inside the JSON).
// Usage: npm run flows:build

const fs = require('fs');
const path = require('path');

const here = __dirname;
const read = (name) =>
  fs.readFileSync(path.join(here, 'function-nodes', name), 'utf8');

const TAB = 'pdm-edge-flow';

const flows = [
  {
    id: TAB,
    type: 'tab',
    label: 'PdM Edge Processing',
    disabled: false,
    info:
      'Subscribes to simulated machine telemetry, maintains a 30 sample rolling ' +
      'window per machine, extracts features every 10 samples, batches them and ' +
      'posts them to the ingestion microservice.',
  },
  {
    id: 'mqtt-broker-config',
    type: 'mqtt-broker',
    name: 'PdM broker',
    broker: 'localhost',
    port: '1883',
    clientid: 'node-red-edge',
    autoConnect: true,
    keepalive: '60',
    cleansession: true,
  },
  {
    id: 'mqtt-in-readings',
    type: 'mqtt in',
    z: TAB,
    name: 'raw readings',
    topic: 'pdm/readings/raw/+',
    qos: '0',
    datatype: 'json',
    broker: 'mqtt-broker-config',
    x: 130,
    y: 120,
    wires: [['fn-window-features']],
  },
  {
    id: 'fn-window-features',
    type: 'function',
    z: TAB,
    name: 'rolling window + features',
    func: read('window-features.js'),
    outputs: 1,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 390,
    y: 120,
    wires: [['fn-batch-post']],
  },
  {
    id: 'fn-batch-post',
    type: 'function',
    z: TAB,
    name: 'batch (25 / 2s)',
    func: read('batch-and-post.js'),
    outputs: 1,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 650,
    y: 120,
    wires: [['http-ingestion']],
  },
  {
    id: 'http-ingestion',
    type: 'http request',
    z: TAB,
    name: 'POST /api/v1/readings',
    method: 'POST',
    ret: 'obj',
    paytoqs: 'ignore',
    url: 'http://localhost:3001/api/v1/readings',
    persist: true,
    x: 900,
    y: 120,
    wires: [['sw-status']],
  },
  {
    id: 'sw-status',
    type: 'switch',
    z: TAB,
    name: 'accepted?',
    property: 'statusCode',
    propertyType: 'msg',
    rules: [
      { t: 'eq', v: '202', vt: 'num' },
      { t: 'else' },
    ],
    outputs: 2,
    x: 1140,
    y: 120,
    wires: [['dbg-accepted'], ['dbg-rejected']],
  },
  {
    id: 'dbg-accepted',
    type: 'debug',
    z: TAB,
    name: 'accepted',
    active: false,
    complete: 'payload',
    x: 1350,
    y: 80,
    wires: [],
  },
  {
    id: 'dbg-rejected',
    type: 'debug',
    z: TAB,
    name: 'rejected',
    active: true,
    complete: 'true',
    x: 1350,
    y: 160,
    wires: [],
  },
];

const outPath = path.join(here, 'flows.json');
fs.writeFileSync(outPath, `${JSON.stringify(flows, null, 2)}\n`);
console.log(`Wrote ${outPath} (${flows.length} nodes)`);
