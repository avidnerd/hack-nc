#!/usr/bin/env bash
# Upload the job code to the bucket and start a vista3d-full Serverless Job.
#   bash vista/job/launch.sh vista/job/batch_smoke.json [platform] [preset]
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
BATCH=${1:?batch json}; PLATFORM=${2:-gpu-h100-sxm}; PRESET=${3:-1gpu-16vcpu-200gb}
S3="aws s3 --endpoint-url $NEBIUS_S3_ENDPOINT --only-show-errors"
$S3 sync pipeline "s3://$NEBIUS_S3_BUCKET/code/pipeline" --exclude "*" --include "*.py"
$S3 sync vista "s3://$NEBIUS_S3_BUCKET/code/vista" --exclude "*" --include "*.py" --include "*.sh" --include "*.json"
NAME="vista3d-full-$(date +%m%d-%H%M%S)"
nebius ai job create --name "$NAME" \
  --image pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime \
  --container-command bash --args "/data/code/vista/job/run.sh --batch /data/code/$BATCH" \
  --volume "$NEBIUS_S3_BUCKET_ID:/data:rw" \
  --platform "$PLATFORM" --preset "$PRESET" --disk-size 100Gi --shm-size 16Gi \
  --timeout 1h --restart-policy never --async
