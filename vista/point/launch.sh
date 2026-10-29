#!/usr/bin/env bash
# Start the vista3d-point Serverless Endpoint (VISTA-3D point prompts, H100).
#   bash vista/point/launch.sh [platform] [preset]
# The bucket is mounted read-only at /data: the server code from
# code/vista/point/ and each case's assets from out/<case>/assets/.
# Writes POINT_BASE_URL, POINT_ENDPOINT_ID and POINT_API_KEY to .env.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
PLATFORM=${1:-gpu-h100-sxm}; PRESET=${2:-1gpu-16vcpu-200gb}
if [ -z "${POINT_API_KEY:-}" ]; then
  POINT_API_KEY=$(openssl rand -hex 24)
  printf '\n# vista3d-point endpoint bearer token\nPOINT_API_KEY=%s\n' "$POINT_API_KEY" >> .env
fi
aws s3 --endpoint-url "$NEBIUS_S3_ENDPOINT" --only-show-errors sync vista/point "s3://$NEBIUS_S3_BUCKET/code/vista/point" --exclude "*" --include "*.py"
CMD="pip install -q --root-user-action=ignore monai==1.4.0 transformers==4.44.2 nibabel==5.2.1 scikit-image==0.23.2 einops==0.7.0 scipy huggingface_hub fastapi 'uvicorn[standard]' && \
cd /data/code/vista/point && exec uvicorn server:app --host 0.0.0.0 --port 8000"
OUT=$(mktemp)
nebius ai endpoint create --name vista3d-point \
  --image pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime \
  --container-command bash --args "-c \"$CMD\"" \
  --container-port 8000 \
  --volume "$NEBIUS_S3_BUCKET_ID:/data:ro" \
  --platform "$PLATFORM" --preset "$PRESET" --disk-size 100Gi --shm-size 16Gi \
  --auth token --token "$POINT_API_KEY" --async --format json > "$OUT"
ID=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("metadata",{}).get("id") or d.get("resource_id") or d["metadata"]["resource_id"])' "$OUT")
echo "endpoint $ID"
URL=""
for _ in $(seq 1 60); do
  URL=$(nebius ai endpoint get "$ID" --format json | python3 -c 'import sys,json;print(next((u for u in json.load(sys.stdin)["status"].get("public_endpoints",[]) if u.startswith("https://")),""))')
  [ -n "$URL" ] && break; sleep 10
done
sed -i '' '/^POINT_BASE_URL=/d; /^POINT_ENDPOINT_ID=/d' .env
printf 'POINT_BASE_URL=%s\nPOINT_ENDPOINT_ID=%s\n' "$URL" "$ID" >> .env
echo "POINT_BASE_URL=$URL (the model loads a few minutes after RUNNING)"
