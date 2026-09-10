#!/usr/bin/env bash
# Prints the features queue depth and the number of inference tasks every few
# seconds, as CSV. Start it before running the load test:
#   ./watch-scaling.sh 600 10 > scaling-run1.csv

set -euo pipefail

DURATION="${1:-600}"
INTERVAL="${2:-10}"
REGION="${AWS_REGION:-ap-southeast-2}"

QUEUE_URL="$(aws sqs get-queue-url --region "$REGION" --queue-name pdm-features --query QueueUrl --output text)"

echo "time,messages_waiting,running_tasks,desired_tasks"

END=$(( $(date +%s) + DURATION ))
while [[ "$(date +%s)" -lt "$END" ]]; do
  MESSAGES="$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$QUEUE_URL" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' --output text)"

  TASKS="$(aws ecs describe-services --region "$REGION" --cluster pdm-cluster --services pdm-inference \
    --query 'services[0].[runningCount,desiredCount]' --output text | tr '\t' ',')"

  echo "$(date +%H:%M:%S),${MESSAGES},${TASKS}"
  sleep "$INTERVAL"
done
