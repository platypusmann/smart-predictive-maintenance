# Smart Predictive Maintenance System

A scalable IoT platform that monitors manufacturing machinery, predicts failures
before they happen, and raises maintenance work orders automatically.

Built for SIT314 (Software Architecture and Scalability for IoT) as the
distinction project. Node.js microservices, Node-RED edge processing, a
scikit-learn model, and an AWS Fargate deployment that auto-scales on queue
depth.

---

## What it does

Simulated machines publish vibration, temperature, current and RPM readings over
MQTT. A Node-RED flow at the edge maintains a 30-second rolling window per
machine and extracts 21 statistical features. Those features go to an ingestion
microservice, which stores them and publishes an event. An inference
microservice consumes the event, scores failure risk with a trained random
forest, and republishes anything above the risk threshold. An alerting service
confirms the signal across consecutive windows and raises a work order.

The queue between ingestion and inference is the architectural centrepiece:
because inference is stateless and driven entirely by the backlog, it can be
scaled from 1 to 10 tasks automatically without any coordination.

---

## Measured results

| What was measured | Result |
| --- | --- |
| Model ROC AUC (held-out test set) | 0.9975 |
| Model recall on failing windows | 0.987 |
| Training data | 949,893 labelled windows from 400 simulated machines |
| Python vs JavaScript scoring agreement | max difference 4.3e-15 |
| Degrading machines detected before failure | 18 / 18 |
| Median early warning | 21.1 minutes (min 6.5, max 34.8) |
| False work orders on healthy machines | 0 |
| Unit and integration tests | 33 passing |
| End-to-end smoke checks | 7 / 7 passing |

Regenerate all of these with `npm run ml:all`, `npm test` and `npm run smoke`.

---

## Repository layout

```
├── ml/                      Model training and export
│   ├── features.py          Canonical feature definition (Python side)
│   ├── generate_dataset.py  Synthetic run-to-failure data generator
│   ├── train_model.py       Training, metrics, threshold sweep, JSON export
│   └── verify_parity.py     Proves the JS scorer matches scikit-learn
│
├── packages/shared/         Code shared by every service
│   └── src/
│       ├── features.js      Feature extraction (must match features.py)
│       ├── forest.js        Pure-JS random forest scorer
│       ├── eventBus.js      MQTT and SQS drivers behind one interface
│       ├── store.js         In-memory and MongoDB drivers
│       ├── policy.js        Work-order decision rules
│       ├── config.js        Environment-driven configuration
│       └── logger.js        Structured logging and metrics
│
├── services/
│   ├── broker/              Local MQTT broker (no Mosquitto install needed)
│   ├── simulator/           Simulated machine fleet with degradation physics
│   ├── edge-bridge/         Headless Node-RED equivalent, for load testing
│   ├── ingestion/           HTTP API, validation, event publishing
│   ├── inference/           Model scoring; the auto-scaling target
│   ├── alerting/            Work-order policy and API
│   └── dashboard/           Fleet overview UI
│
├── node-red/
│   ├── function-nodes/      Function node sources as real, testable .js files
│   ├── build-flows.js       Assembles flows.json from those sources
│   └── flows.json           Importable Node-RED flow
│
├── infra/aws/
│   ├── cloudformation/      Foundation and services stacks
│   └── scripts/             deploy.sh, watch-scaling.sh, teardown.sh
│
├── loadtest/                Ramped load generator producing CSV evidence
├── scripts/                 run-stack.js, smoke-test.js
└── tests/                   Unit and integration tests
```

---

## Quick start

Requires Node.js 20+ and Python 3.10+. Nothing else: no Docker, no Mosquitto,
no database.

```bash
# 1. Install dependencies
npm install
pip install -r ml/requirements.txt

# 2. Train the model (about 2 minutes)
npm run ml:all

# 3. Check everything works
npm test
npm run smoke

# 4. Run the platform
npm run start:stack
```

Then open http://localhost:3000 for the dashboard.

---

## Command reference

### Machine learning

```bash
npm run ml:dataset     # generate the training dataset
npm run ml:train       # train, report metrics, export model.json
npm run ml:parity      # prove the JS scorer matches scikit-learn
npm run ml:all         # all three in order

# Non-default options
cd ml
python3 generate_dataset.py --machines 800 --seed 42
python3 train_model.py --trees 100 --max-depth 12
python3 verify_parity.py --cases 2000
```

### Testing

```bash
npm test                                  # all tests
node --test tests/policy.test.js          # one file
npm run smoke                             # end-to-end against a live stack
```

### Running locally

```bash
npm run start:stack                          # everything, 20 machines
npm run start:stack -- --machines 100        # bigger fleet
npm run start:stack -- --duration 60         # timed run, prints a summary
npm run start:stack -- --node-red            # use Node-RED instead of the bridge
npm run start:stack -- --no-simulator        # for load testing

# Or start services individually, one per terminal
npm run start:broker
npm run start:ingestion
npm run start:inference
npm run start:alerting
npm run start:dashboard
npm run start:simulator -- --machines 50
npm run start:edge
```

Persist to a real database instead of memory:

```bash
export STORE_DRIVER=mongo
export MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net"
npm run start:stack
```

### Node-RED

```bash
npm run flows:build          # rebuild flows.json from function-nodes/
npx node-red                 # then import node-red/flows.json via the menu
```

Start the stack with `--node-red` so the headless bridge does not compete with
the flow for the same MQTT messages.

### Load testing

```bash
# Terminal 1
npm run start:stack -- --no-simulator

# Terminal 2
npm run loadtest
npm run loadtest -- --stages 10,50,100,250,500 --stage-seconds 120
```

Results are written to `loadtest/results/` as JSON and CSV.

To make scale-out observable without a huge fleet, give each message more work:

```bash
CPU_BURN_MS=15 npm run start:stack -- --no-simulator
```

### Docker

```bash
docker compose up --build
docker compose --profile load up          # adds simulator and edge bridge
docker compose up --scale inference=4     # multiple consumers on one queue
```

### AWS deployment

```bash
export AWS_REGION=ap-southeast-2
export MONGO_URI="mongodb+srv://..."

cd infra/aws/scripts
./deploy.sh foundation    # network, ECR, SQS queues, secrets
./deploy.sh images        # build and push (verifies model parity first)
./deploy.sh services      # ECS, ALB, auto-scaling policies

# Capture scaling evidence during a load test
./watch-scaling.sh 600 10 > scaling-run1.csv

# Always tear down afterwards
./teardown.sh
```

---

## Design decisions worth knowing

**The model is scored in JavaScript, not Python.** `train_model.py` exports the
random forest to JSON and `packages/shared/src/forest.js` walks the trees
directly. This keeps the inference service a plain Node.js container with no
Python runtime or native ONNX dependency. `verify_parity.py` exists because that
choice is only safe if the two implementations agree, and it proves they agree
to 4.3e-15.

**Scaling is driven by queue backlog, not CPU.** A task blocked on SQS
long-polling looks idle even while the backlog grows, so CPU alone would scale
too late. Backlog-per-task reflects whether the fleet is actually keeping up.
CPU is kept as a secondary policy.

**Alerts require confirmation.** One window crossing the threshold does not
raise a work order. The machine must breach on three consecutive windows, and a
cooldown then mutes it. Without this, the 0.61 precision at the raw threshold
would put far too many false alarms in front of a technician.

**Two edge implementations exist.** Node-RED is the real one and is what the
project demonstrates. The headless bridge exists because Node-RED's runtime
saturates long before the microservices do, and a load test measuring Node-RED
would not say anything about whether the architecture scales. Both import their
windowing logic from the same shared module.

**Storage and messaging are pluggable.** `STORE_DRIVER` switches between memory
and MongoDB; `EVENT_BUS_DRIVER` switches between MQTT and SQS. The same code
runs on a laptop and on Fargate.

---

## Known limitations

- Training data is synthetic. The degradation model is physically plausible but
  it is not real machinery, so the accuracy figures describe the pipeline, not
  the real world. Validating against a public dataset such as NASA C-MAPSS or
  UCI AI4I is the natural next step.
- The dashboard polls every two seconds rather than streaming.
- Work orders are created but there is no acknowledge or close workflow.
- The plan specified DynamoDB for readings and RDS for work orders; this
  implementation uses MongoDB for both, behind the store interface.
