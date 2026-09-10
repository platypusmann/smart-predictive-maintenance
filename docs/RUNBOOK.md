# Runbook

Steps for getting results and screenshots for the report.

1. **Model**: run `npm run ml:dataset` then `npm run ml:train`. Screenshot the
   ROC AUC, confusion matrix and threshold table. The numbers are also saved in
   `ml/artifacts/metrics.json`.

2. **Parity check**: run `npm run ml:parity`. It should end with PASS.

3. **Tests**: run `docker compose up -d mongo`, then `npm test` and `npm run smoke`.

4. **Local demo**:
   `npm run start:stack -- --machines 15 --interval 200 --duration 180`
   runs for 3 minutes and prints a summary. Leave off `--duration` to watch the
   dashboard at http://localhost:3000 instead. `--interval` and `--time-scale`
   just speed things up for the demo; real sensors would be 1 reading per second.

5. **Node-RED**: start `npx node-red`, import `node-red/flows.json`, then run
   `npm run start:stack -- --node-red --machines 10`. Screenshot the flow.

6. **AWS deploy**: follow the steps in the README. Screenshot the CloudFormation
   stacks, the ECS services and the SQS queues.

7. **Auto scaling test**:
   - terminal 1 (start this before the load): `./watch-scaling.sh 900 10 > scaling-run1.csv`
   - terminal 2: `INGESTION_URL=http://<alb-dns> API_KEY=<key> npm run loadtest -- --stages 25,100,250 --stage-seconds 180`
   - leave watch-scaling running for a few minutes afterwards so the scale in shows up too
   - graph queue depth and task count against time
   - if it doesn't scale out, change `CPU_BURN_MS` to 15 in the inference task
     definition (02-services.yaml) and redeploy

8. **Teardown**: run `./teardown.sh` after every session.
