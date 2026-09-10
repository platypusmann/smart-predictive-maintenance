#!/usr/bin/env bash
# Delete everything from AWS. Run after each session - Fargate and the load
# balancer cost money even when nothing is happening.

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-2}"

read -rp "Delete the pdm stacks in ${REGION}? [y/N] " CONFIRM
[[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "Cancelled."; exit 0; }

# services stack has to go first because it uses the foundation exports
echo "Deleting pdm-services..."
aws cloudformation delete-stack --region "$REGION" --stack-name pdm-services
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name pdm-services

# ECR repos can't be deleted while they still have images in them
echo "Deleting images..."
for service in ingestion inference alerting; do
  IMAGES="$(aws ecr list-images --region "$REGION" --repository-name "pdm/${service}" \
    --query 'imageIds[*]' --output json 2>/dev/null || echo '[]')"
  if [[ "$IMAGES" != "[]" ]]; then
    aws ecr batch-delete-image --region "$REGION" --repository-name "pdm/${service}" \
      --image-ids "$IMAGES" > /dev/null
  fi
done

echo "Deleting pdm-foundation..."
aws cloudformation delete-stack --region "$REGION" --stack-name pdm-foundation
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name pdm-foundation

echo "Done."
