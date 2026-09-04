#!/usr/bin/env bash
#
# Record the auto-scaling response during a load test.
#
# Samples the features queue depth and the inference service's running task
# count once per interval and writes them to CSV. This file is the primary
# evidence that the service scales automatically under load, so it is worth
# starting it before the load test and leaving it running until well after,
# to capture the scale-in as well as the scale-out.
#
#   ./watch-scaling.sh 600 10 > scaling-run1.csv

set -euo pipefail

DURATION="${1:-600}"
INTERVAL="${2:-10}"
PROJECT="${PROJECT_NAME:-pdm}"
REGION="${AWS_REGION:-ap-southeast-2}"

QUEUE_URL="$(aws cloudformation describe-stacks \
  --region "$REGION" --stack-name "${PROJECT}-foundation" \
  --query "Stacks[0].Outputs[?OutputKey=='FeaturesQueueUrl'].OutputValue" \
  --output text)"

echo "timestamp,elapsed_s,messages_visible,messages_in_flight,running_tasks,desired_tasks"

START="$(date +%s)"
END=$(( START + DURATION ))

while [[ "$(date +%s)" -lt "$END" ]]; do
  NOW="$(date +%s)"

  ATTRS="$(aws sqs get-queue-attributes \
    --region "$REGION" \
    --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes' --output json)"

  VISIBLE="$(echo "$ATTRS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ApproximateNumberOfMessages"])')"
  INFLIGHT="$(echo "$ATTRS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ApproximateNumberOfMessagesNotVisible"])')"

  TASKS="$(aws ecs describe-services \
    --region "$REGION" \
    --cluster "${PROJECT}-cluster" \
    --services "${PROJECT}-inference" \
    --query 'services[0].[runningCount,desiredCount]' --output text)"

  RUNNING="$(echo "$TASKS" | cut -f1)"
  DESIRED="$(echo "$TASKS" | cut -f2)"

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$(( NOW - START )),${VISIBLE},${INFLIGHT},${RUNNING},${DESIRED}"
  sleep "$INTERVAL"
done
