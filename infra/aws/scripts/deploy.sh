#!/usr/bin/env bash
# Deploy to AWS
#   ./deploy.sh foundation   VPC, ECR repos, SQS queues, secrets
#   ./deploy.sh images       build and push the docker images
#   ./deploy.sh services     ECS services, load balancer, auto scaling
#   ./deploy.sh all

set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-2}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

deploy_foundation() {
  echo "==> foundation stack"
  aws cloudformation deploy --region "$REGION" --stack-name pdm-foundation \
    --template-file "$ROOT/infra/aws/cloudformation/01-foundation.yaml" \
    --no-fail-on-empty-changeset

  if [[ -n "${MONGO_URI:-}" ]]; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id pdm/mongo-uri \
      --secret-string "$MONGO_URI" > /dev/null
    echo "saved MONGO_URI to secrets manager"
  else
    echo "MONGO_URI not set - add it to the pdm/mongo-uri secret before deploying services"
  fi
}

build_images() {
  if [[ ! -f "$ROOT/ml/artifacts/model.json" ]]; then
    echo "ml/artifacts/model.json is missing, run npm run ml:all first"
    exit 1
  fi

  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"

  for service in ingestion inference alerting; do
    echo "==> $service image"
    docker build -f "$ROOT/services/$service/Dockerfile" -t "$REGISTRY/pdm/$service:latest" "$ROOT"
    docker push "$REGISTRY/pdm/$service:latest"
  done
}

deploy_services() {
  echo "==> services stack"
  aws cloudformation deploy --region "$REGION" --stack-name pdm-services \
    --template-file "$ROOT/infra/aws/cloudformation/02-services.yaml" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset

  aws cloudformation describe-stacks --region "$REGION" --stack-name pdm-services \
    --query "Stacks[0].Outputs[?OutputKey=='IngestionEndpoint'].OutputValue" --output text
}

case "${1:-all}" in
  foundation) deploy_foundation ;;
  images) build_images ;;
  services) deploy_services ;;
  all) deploy_foundation; build_images; deploy_services ;;
  *) echo "usage: $0 foundation|images|services|all"; exit 1 ;;
esac
