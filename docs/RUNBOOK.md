# Evidence runbook

Step-by-step procedures for reproducing every number quoted in the project
status and final reports. Run these in order; each produces an artefact worth
screenshotting or attaching.

---

## 1. Model quality

```bash
npm run ml:dataset
npm run ml:train
```

Capture from the output:

- ROC AUC and average precision
- The confusion matrix
- The threshold sweep table, which justifies `RISK_THRESHOLD=0.7`
- Feature importances

Written to `ml/artifacts/metrics.json`.

Reference figures from the recorded run: ROC AUC 0.9975, average precision
0.9217, recall on failing windows 0.987, 949,893 windows from 400 machines.

Note that precision at the raw 0.5 threshold is only 0.539. Do not hide this.
The correct framing is that raw model precision is deliberately not the
operating point: the alerting service's three-window confirmation streak is
what converts a high-recall, low-precision signal into an actionable alert.

---

## 2. Python / JavaScript parity

```bash
npm run ml:parity
```

Capture the parity report. Reference figures: max feature difference 1.4e-12,
max score difference 4.3e-15, across 500 random windows.

This matters because the deployed model is the JSON export scored in
JavaScript, not the `.joblib`. Without this check, the accuracy figures in
section 1 would not be claims about the running system at all.

---

## 3. Test suite

```bash
npm test
```

Reference: 33 tests passing across four files. The pipeline integration test
prints the fleet detection summary:

```
fleet detection: 18/18 machines flagged before failure
lead time (minutes): min 6.5, median 21.1, max 34.8
```

That lead time figure is the single most important business result in the
project. It is what turns "the model is accurate" into "a technician has 21
minutes of warning".

---

## 4. End-to-end smoke test

```bash
npm run smoke
```

Reference: 7/7 checks. Covers service health, 401 on unauthenticated requests,
400 on malformed feature vectors, a faulted machine scoring 0.997, a healthy
machine scoring 0.000, and a work order actually being raised.

Screenshot this. It is the most compact single piece of evidence that the
architecture works as designed.

---

## 5. Live pipeline demonstration

```bash
npm run start:stack -- --machines 15 --time-scale 120 --interval 200 --duration 180
```

Runs for three minutes and prints a summary: readings accepted, events
published, predictions scored, high-risk events, work orders raised, and p95
latency at each stage.

`--time-scale` compresses machine life so a full degradation cycle completes
inside the run; `--interval` shortens the sampling period so the 30-sample
window fills quickly. Both are demo conveniences and should be stated as such,
because a real deployment samples at 1 Hz in real time.

For the visual demonstration, run without `--duration` and open the dashboard at
http://localhost:3000. Work orders appear in the lower panel as machines
degrade.

---

## 6. Node-RED flow

```bash
npm run flows:build
npx node-red
```

Import `node-red/flows.json` through the hamburger menu, then start the stack
with `--node-red` so the headless bridge does not consume the same messages:

```bash
npm run start:stack -- --node-red --machines 10
```

Screenshot the flow canvas with the function node status showing the tracked
machine count. That screenshot is the evidence for the "flow based processing
using Node-RED" requirement.

---

## 7. Local scaling behaviour

Demonstrates that multiple consumers share one queue correctly, without
requiring AWS.

```bash
docker compose up --build -d
docker compose up --scale inference=4 -d    # remove the inference ports mapping first
docker compose --profile load up -d
```

Watch each replica's log lines: the `instance` field differs, and the total
`predictions_scored` across replicas equals the events published. That proves
work is distributed rather than duplicated.

---

## 8. AWS deployment

```bash
export AWS_REGION=ap-southeast-2
export MONGO_URI="mongodb+srv://..."

cd infra/aws/scripts
./deploy.sh foundation
./deploy.sh images
./deploy.sh services
```

Capture:

- CloudFormation stack list showing both stacks CREATE_COMPLETE
- The ECS cluster page showing three running services
- The SQS console showing both queues and their dead letter queues
- The IAM console showing the three task roles, to evidence least privilege
- The ALB listener showing the TLS policy, to evidence secure deployment

---

## 9. Auto-scaling experiment

This is the core scalability evidence. Run it deliberately.

Terminal 1, start recording before generating any load, so the baseline is
captured:

```bash
cd infra/aws/scripts
./watch-scaling.sh 900 10 > scaling-run1.csv
```

Terminal 2, ramp the load:

```bash
npm run loadtest -- \
  --stages 25,100,250,500 \
  --stage-seconds 180
```

Let `watch-scaling.sh` keep running for several minutes after the load stops, so
the scale-in is captured as well as the scale-out. A graph showing only
scale-out is half the story.

Plot from `scaling-run1.csv`:

- Queue depth against time, with the load stages marked
- Running task count against time on the same axis

The expected shape is a backlog spike, task count climbing 60 to 120 seconds
later, backlog draining as capacity arrives, then task count falling back after
the 300 second scale-in cooldown. The lag between backlog and task count is not
a defect; it is the cooldown behaving as configured, and it should be discussed
rather than apologised for.

From `loadtest/results/loadtest-*.csv`, tabulate offered rate against accepted
rate, p95 latency and error rate per stage. The interesting question is where
accepted rate stops tracking offered rate, because that is the point where the
system's limit is found.

If scale-out does not trigger, the fleet is too small to saturate a task.
Redeploy with `CPU_BURN_MS=15` rather than inflating the machine count.

---

## 10. Teardown

```bash
./teardown.sh
```

Run after every session. Fargate tasks and the load balancer bill hourly
regardless of traffic, and this is the main cost control on a student budget.

---

## Reporting honestly

A few things worth stating plainly in the report rather than glossing over:

- Training data is synthetic. The accuracy figures describe the pipeline, not
  real machinery.
- The demo compresses time. Real deployments sample at 1 Hz in real time.
- Alerting is single-task because it holds streak state in memory. Scaling it
  needs that state moved to a shared store; this is identified, not solved.
- MongoDB replaced the planned DynamoDB and RDS split, behind an interface that
  allows the split to be restored.

Naming these costs nothing and is a great deal more convincing than a report
where everything worked perfectly first time.
