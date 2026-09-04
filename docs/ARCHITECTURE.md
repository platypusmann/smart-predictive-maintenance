# Architecture

## Data flow

```
Simulated sensors (1 Hz per machine)
        │  MQTT  pdm/readings/raw/{machineId}
        ▼
Node-RED edge flow
   30-sample rolling window per machine
   21 features extracted every 10 samples
   batched 25 vectors / 2 s
        │  HTTPS  POST /api/v1/readings   (x-api-key)
        ▼
Ingestion microservice
   validates shape and feature count
   persists readings
   publishes one event per vector
        │  SQS  pdm-features
        ▼
Inference microservice  ◄── auto-scales on queue backlog
   scores the random forest
   persists the prediction
   republishes if risk ≥ threshold
        │  SQS  pdm-high-risk
        ▼
Alerting microservice
   confirmation streak + cooldown
   creates a work order
        │
        ▼
Dashboard / technician
```

## Feature vector

21 features per window. Four channels (vibration, temperature, current, RPM)
each contribute mean, population standard deviation, min, max and least-squares
slope, plus machine runtime in hours.

Order is fixed and defined in exactly two places, `ml/features.py` and
`packages/shared/src/features.js`. Those two files are duplicated logic and
therefore a real risk, which is why `verify_parity.py` compares them on 500
random windows and `tests/nodered.test.js` compares the Node-RED function node
against the shared module. Feature order matters because the model indexes into
the vector positionally: a silent reordering would not throw, it would just
degrade predictions.

Top features by importance from the trained model:

| Feature | Importance |
| --- | --- |
| vibration_mean | 0.214 |
| vibration_min | 0.197 |
| vibration_max | 0.112 |
| temperature_mean | 0.109 |
| temperature_max | 0.063 |

Vibration dominating matches the domain: bearing and imbalance faults show up
in vibration well before they show up as heat.

## Data design

**Collection `readings`** — time-series, high write volume, flexible schema.

```js
{
  machineId: 'M-0042',           // indexed with timestamp
  machineType: 'pump',
  timestamp: ISODate(...),
  runtimeHours: 4.7,
  vibration: 3.1, temperature: 58.2, current: 12.4, rpm: 1443,
  features: [ /* 21 floats */ ]
}
```

**Collection `predictions`** — one per scored window.

```js
{
  machineId: 'M-0042',
  timestamp: ISODate(...),
  riskScore: 0.83,
  predictedFailing: true,
  modelVersion: '1.0.0',
  inferenceLatencyMs: 2.1
}
```

**Collection `work_orders`** — low volume, well-defined workflow state.

```js
{
  machineId: 'M-0042',
  createdAt: ISODate(...),
  riskScore: 0.91,
  consecutiveBreaches: 3,
  status: 'open',                // open | acknowledged | closed
  assignedTechnician: null,
  notes: 'Automatically raised: model 1.0.0 scored 0.910 on 3 consecutive windows.'
}
```

The project plan specified DynamoDB for readings and RDS for work orders. This
implementation uses MongoDB for all three collections behind the store
interface. The reasoning: the split added two managed services and two access
patterns for no benefit at this scale, and the work-order collection is small
enough that losing relational joins costs nothing. The interface in
`store.js` means the split can still be made later without touching any service.

## Scalability

**Where the load lands.** Each machine produces one reading per second and one
feature vector every ten seconds. At 500 machines that is 500 readings/s at the
edge but only 50 feature vectors/s reaching the cloud, because windowing at the
edge reduces volume by an order of magnitude before anything crosses the
network. This is the single biggest scalability decision in the design.

**Why inference is the scaling target.** Ingestion is IO-bound and cheap.
Alerting handles only the small fraction of events above the threshold. Scoring
60 decision trees per event is the CPU-bound step, so it is the one that needs
to scale independently.

**Why the queue matters.** Without it, a burst of sensor traffic would apply
backpressure straight through ingestion to the edge, and a slow model would drop
readings. With it, the backlog absorbs the burst and the only consequence is
latency, which then triggers a scale-out.

**Why backlog and not CPU.** A task blocked on SQS long-polling reports low CPU
even while the queue grows, so a CPU-only policy scales late. Backlog-per-task
directly measures whether the fleet is keeping up. Target is 30 messages per
task, scale-out cooldown 60 s, scale-in cooldown 300 s, so capacity is added
quickly and removed cautiously.

**What is stateless and what is not.** Inference holds no per-machine state, so
tasks can be added or killed freely. Alerting does hold streak state per machine
in memory, which is why it runs as a single task. Scaling it would require
moving that state to a shared store, and this is a known limitation rather than
a solved problem.

## Security

| Control | Implementation |
| --- | --- |
| Transport encryption | TLS at the ALB, TLS 1.2/1.3 policy |
| Authentication | API key on `/api/v1/readings`, rejected with 401 before any work |
| Secrets | Secrets Manager; never in images, task definitions or code |
| Least privilege | Per-service task roles: ingestion can send to the features queue but not read it; inference can read features and send to high-risk; alerting can only read high-risk |
| Network isolation | Tasks accept traffic only from the load balancer security group, never from a CIDR |
| Container hardening | Multi-stage build, production dependencies only, non-root user, dumb-init for signal handling |
| Input validation | Feature count and finiteness checked at the ingestion boundary |
| Failure isolation | Dead letter queues with maxReceiveCount 5, so a poison message cannot hold the backlog high and pin the service scaled out |

## Testing strategy

Four layers, each answering a different question.

1. **Unit tests** — does each piece work in isolation? Feature statistics
   against known values, the forest's `<=` split rule exactly at the threshold,
   the alert policy's streak and cooldown transitions.
2. **Parity tests** — do the duplicated implementations agree? Python vs
   JavaScript features and scores; Node-RED function node vs shared module.
3. **Integration test** — does the chain deliver useful warning? Simulated
   machines run to failure through window, features, model and policy, measuring
   lead time and false alarms.
4. **Smoke test** — are the services actually wired together? Boots the real
   stack on isolated ports and drives HTTP traffic through it.

Layer 3 is the one that answers the project's actual question. A pipeline can
pass every unit test and still be useless if it only flags a machine thirty
seconds before it dies.
