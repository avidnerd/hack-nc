#!/usr/bin/env bash
# Upload trainer + SFT data and start the distill-nano Serverless Job (H100).
#   bash distill/job/launch.sh [extra train.py args]
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
S3="aws s3 --endpoint-url $NEBIUS_S3_ENDPOINT --only-show-errors"
$S3 cp distill/job/train.py "s3://$NEBIUS_S3_BUCKET/code/distill/job/train.py"
$S3 cp distill/job/diag.py "s3://$NEBIUS_S3_BUCKET/code/distill/job/diag.py"
$S3 cp distill/job/run.sh "s3://$NEBIUS_S3_BUCKET/code/distill/job/run.sh"
$S3 sync distill/data "s3://$NEBIUS_S3_BUCKET/distill/data" --exclude "*" --include "sft_*.jsonl"
RUN=${RUN:-lora-$(date +%m%d-%H%M)}
echo "run $RUN"
nebius ai job create --name "distill-nano-$RUN" \
  --image pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel \
  --container-command bash --args "/data/code/distill/job/run.sh $RUN $*" \
  --volume "$NEBIUS_S3_BUCKET_ID:/data:rw" \
  --platform gpu-h100-sxm --preset 1gpu-16vcpu-200gb --disk-size 200Gi --shm-size 32Gi \
  --timeout ${TIMEOUT:-8h} --restart-policy never --async
