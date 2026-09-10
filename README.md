# Smart Predictive Maintenance System

SIT314 project. Simulated factory machines send sensor readings over MQTT,
Node-RED works out features at the edge, and three Node.js microservices save
the data, predict failures with a random forest model and raise work orders.
It's deployed to AWS ECS Fargate, and the inference service auto scales on SQS
queue depth.

## How it works

```
simulator --MQTT--> Node-RED --HTTP--> ingestion --queue--> inference --queue--> alerting --> work orders
```

- **simulator**: fake machines that slowly break down
- **Node-RED** (or **edge-bridge**): keeps a rolling window of 30 readings per
  machine, calculates 21 features and posts them to ingestion in batches
- **ingestion**: checks the data, saves it to MongoDB and publishes an event
- **inference**: scores each event with the model and passes high risk ones on
- **alerting**: raises a work order when a machine is high risk 3 windows in a row
- **dashboard**: http://localhost:3000

Locally the services talk to each other over MQTT. On AWS they use SQS queues
instead (`USE_SQS=true`). More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Folders

```
ml/                 dataset generator, model training, Python vs JS parity check
packages/shared/    code used by more than one service (features, model scoring,
                    alert policy, MQTT/SQS messaging, config, logger)
services/           broker, simulator, edge-bridge, ingestion, inference, alerting, dashboard
node-red/           the flow and its function node code
infra/aws/          CloudFormation templates and deploy / teardown scripts
loadtest/           load test script
scripts/            run-stack.js and smoke-test.js
tests/              unit tests and a pipeline test
```

## Setup

You need Node 20+, Python 3.10+ and Docker (for MongoDB).

```bash
npm install
pip install -r ml/requirements.txt
npm run ml:all               # make the dataset, train the model, run the parity check
docker compose up -d mongo   # MongoDB on localhost:27017
```

## Running it

```bash
npm test                     # unit tests + pipeline test
npm run smoke                # starts the services and checks a work order gets raised
npm run start:stack          # everything, with 20 simulated machines
```

Options for `start:stack`:
- `--machines 100`
- `--node-red` to use Node-RED instead of the edge bridge
- `--no-simulator`
- `--duration 180` to stop after 3 minutes and print a summary

**Node-RED:** run `npx node-red`, import `node-red/flows.json`, then start the
stack with `--node-red`. If you edit the files in `node-red/function-nodes/`,
run `npm run flows:build` to rebuild flows.json.

**Load test:** start the stack with `--no-simulator`, then run
`npm run loadtest -- --stages 10,50,100 --stage-seconds 60`. Setting
`CPU_BURN_MS=15` makes inference do extra work per message, so scaling kicks
in sooner.

**Docker:** `docker compose up --build` runs everything in containers.

## Deploying to AWS

```bash
export AWS_REGION=ap-southeast-2
export MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/pdm"

cd infra/aws/scripts
./deploy.sh foundation      # VPC, ECR, SQS queues, secrets
./deploy.sh images          # build and push the docker images
./deploy.sh services        # ECS, load balancer, auto scaling (prints the URL)

# watch queue depth and task count while load testing
./watch-scaling.sh 600 10 > scaling.csv
# in another terminal (get the key from the pdm/edge-api-key secret)
INGESTION_URL=http://<load balancer url> API_KEY=<key> npm run loadtest

./teardown.sh               # delete everything afterwards so it doesn't cost money
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the steps used to get results for the report.

## Notes

- Model ROC AUC on the test set is 0.9975 (see `ml/artifacts/metrics.json`)
- The training data is simulated, not from real machines
- Alerting keeps its streak counts in memory, so it only runs as 1 task
- The plan said DynamoDB + RDS, but MongoDB is used for everything
