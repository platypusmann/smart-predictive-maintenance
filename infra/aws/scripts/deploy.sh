#!/usr/bin/env bash
#
# Deploy the platform to AWS.
#
#   ./deploy.sh foundation          # network, ECR repos, SQS queues, secrets
#   ./deploy.sh images              # build and push all three service images
#   ./deploy.sh services            # ECS cluster, tasks, ALB, auto-scaling
#   ./deploy.sh all
#
# Requires: aws cli v2, docker, and credentials with permission to create the
# resources in the CloudFormation templates.

set -euo pipefail

PROJECT="${PROJECT_NAME:-pdm}"
REGION="${AWS_REGION:-ap-southeast-2}"
TAG="${IMAGE_TAG:-latest}"
CERT_ARN="${CERTIFICATE_ARN:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEMPLATES="$ROOT/infra/aws/cloudformation"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

deploy_foundation() {
  log "Deploying foundation stack (${PROJECT}-foundation)"
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "${PROJECT}-foundation" \
    --template-file "$TEMPLATES/01-foundation.yaml" \
    --parameter-overrides "ProjectName=${PROJECT}" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset

  log "Storing the MongoDB connection string"
  if [[ -n "${MONGO_URI:-}" ]]; then
    aws secretsmanager put-secret-value \
      --region "$REGION" \
      --secret-id "${PROJECT}/mongo-uri" \
      --secret-string "$MONGO_URI" >/dev/null
    echo "    stored from \$MONGO_URI"
  else
    echo "    MONGO_URI not set; set it in Secrets Manager before deploying services"
  fi
}

build_and_push() {
  log "Checking the exported model exists"
  if [[ ! -f "$ROOT/ml/artifacts/model.json" ]]; then
    echo "ERROR: ml/artifacts/model.json is missing. Run 'npm run ml:all' first." >&2
    exit 1
  fi

  log "Verifying Python/JS parity before shipping the model"
  (cd "$ROOT/ml" && python3 verify_parity.py --cases 200)

  log "Logging in to ECR"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"

  for service in ingestion inference alerting; do
    log "Building ${service}"
    docker build \
      --file "$ROOT/services/${service}/Dockerfile" \
      --tag "${REGISTRY}/${PROJECT}/${service}:${TAG}" \
      "$ROOT"

    log "Pushing ${service}"
    docker push "${REGISTRY}/${PROJECT}/${service}:${TAG}"
  done
}

deploy_services() {
  log "Deploying services stack (${PROJECT}-services)"
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "${PROJECT}-services" \
    --template-file "$TEMPLATES/02-services.yaml" \
    --parameter-overrides \
        "ProjectName=${PROJECT}" \
        "ImageTag=${TAG}" \
        "CertificateArn=${CERT_ARN}" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset

  log "Endpoint"
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "${PROJECT}-services" \
    --query "Stacks[0].Outputs[?OutputKey=='IngestionEndpoint'].OutputValue" \
    --output text
}

case "${1:-all}" in
  foundation) deploy_foundation ;;
  images)     build_and_push ;;
  services)   deploy_services ;;
  all)        deploy_foundation; build_and_push; deploy_services ;;
  *)          echo "Usage: $0 {foundation|images|services|all}" >&2; exit 1 ;;
esac

log "Done"
