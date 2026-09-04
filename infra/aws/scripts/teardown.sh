#!/usr/bin/env bash
#
# Delete every resource this project creates.
#
# Running this after each experiment session is the main cost control on a
# student budget: Fargate tasks and the load balancer bill by the hour whether
# or not any traffic is flowing.

set -euo pipefail

PROJECT="${PROJECT_NAME:-pdm}"
REGION="${AWS_REGION:-ap-southeast-2}"

read -rp "Delete all ${PROJECT} stacks in ${REGION}? [y/N] " CONFIRM
[[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "Cancelled."; exit 0; }

# Services first: the foundation stack's exports cannot be deleted while the
# services stack still imports them.
echo "Deleting ${PROJECT}-services..."
aws cloudformation delete-stack --region "$REGION" --stack-name "${PROJECT}-services"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "${PROJECT}-services"

echo "Emptying ECR repositories..."
for service in ingestion inference alerting; do
  IMAGES="$(aws ecr list-images --region "$REGION" \
    --repository-name "${PROJECT}/${service}" \
    --query 'imageIds[*]' --output json 2>/dev/null || echo '[]')"
  if [[ "$IMAGES" != "[]" ]]; then
    aws ecr batch-delete-image --region "$REGION" \
      --repository-name "${PROJECT}/${service}" \
      --image-ids "$IMAGES" >/dev/null
  fi
done

echo "Deleting ${PROJECT}-foundation..."
aws cloudformation delete-stack --region "$REGION" --stack-name "${PROJECT}-foundation"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "${PROJECT}-foundation"

echo "Teardown complete."
