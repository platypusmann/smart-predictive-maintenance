# Architecture notes

## Data flow

```
Simulator (1 reading per second per machine)
   |  MQTT  pdm/readings/raw/<machineId>
   v
Node-RED (or edge-bridge)
   - rolling window of 30 readings per machine
   - 21 features every 10 readings
   - sends in batches of 25 (or every 2s)
   |  HTTP POST /api/v1/readings  (x-api-key header)
   v
Ingestion  --> MongoDB (readings)
   |  pdm/events/features   (MQTT locally, SQS queue on AWS)
   v
Inference  --> MongoDB (predictions)     <-- auto scales on AWS
   |  pdm/events/high-risk  (only when risk >= 0.7)
   v
Alerting   --> MongoDB (workorders)
   |
   v
Dashboard
```

## Features and model

Each window gives 21 features: mean, std, min, max and slope for vibration,
temperature, current and rpm, plus runtime hours. They're calculated in
`ml/features.py` for training and `packages/shared/src/features.js` for the
services (the Node-RED function node has its own copy of the JS version).
`npm run ml:parity` checks the Python and JS versions give the same answers.

The model is a scikit-learn random forest (60 trees, max depth 10) trained on
simulated run-to-failure data. A window is labelled as failing if the machine
breaks within 10 minutes. `train_model.py` exports the trees to `model.json`
and `forest.js` scores them in plain JS, so the inference service doesn't
need Python.

## MongoDB collections

- `readings`: machineId, machineType, timestamp, runtimeHours, raw sensor values, features
- `predictions`: machineId, timestamp, riskScore, predictedFailing, modelVersion, inferenceLatencyMs
- `workorders`: machineId, createdAt, riskScore, consecutiveBreaches, status (open / acknowledged / closed), notes

Each service defines its own mongoose model and connects straight to Mongo.

## Scaling

- Doing the windowing at the edge means only one feature vector per machine
  every 10 seconds gets sent to the cloud, not every reading.
- The queue between ingestion and inference means a burst of data just builds
  up in the queue instead of overloading inference.
- Inference doesn't keep any state, so ECS can add and remove tasks freely.
- Auto scaling policy: target tracking on `ApproximateNumberOfMessagesVisible`
  for the `pdm-features` queue, target 30, between 1 and 10 tasks, scale out
  cooldown 60s and scale in cooldown 300s.
- Alerting keeps the streak counts in memory, so it stays at 1 task.

## Security

- The API key is required to post readings
- The Mongo connection string and API key are kept in Secrets Manager
- ECS tasks only accept traffic from the load balancer's security group
- The services share one task role that can only use the `pdm-*` SQS queues
