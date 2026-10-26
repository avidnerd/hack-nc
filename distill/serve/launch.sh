#!/usr/bin/env bash
# Start the scrub-nano Serverless Endpoint: vLLM serving Nemotron Nano 9B v2
# behind an OpenAI-compatible API with a bearer token.
#   bash distill/serve/launch.sh base        the base weights, model name "base"
#   bash distill/serve/launch.sh <run>       the merged LoRA from distill/job/merge.py
#                                            (/data/distill/runs/<run>/merged), model name "scrub"
# DECISION: merged weights, not --enable-lora. vLLM 0.11's LoRA manager fails
# at startup on NemotronH ("assert isinstance(module, BaseLayerWithLoRA)"),
# which is the fallback docs/PLATFORM_NOTES.md section 4 planned for.
# Writes NANO_BASE_URL, NANO_ENDPOINT_ID and NANO_API_KEY to .env.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
WHAT=${1:?base or a training run name}
PLATFORM=${2:-gpu-h100-sxm}; PRESET=${3:-1gpu-16vcpu-200gb}
if [ -z "${NANO_API_KEY:-}" ]; then
  NANO_API_KEY=$(openssl rand -hex 24)
  printf '\n# scrub-nano endpoint bearer token\nNANO_API_KEY=%s\n' "$NANO_API_KEY" >> .env
fi
M=nvidia/NVIDIA-Nemotron-Nano-9B-v2
OUT=$(mktemp)
# The tool-call parser plugin ships in the model repo, so the base repo is
# always fetched to local disk (flags from the model card).
if [ "$WHAT" = base ]; then SRC=/root/nano; NAME=base; else SRC=/data/distill/runs/$WHAT/merged; NAME=scrub; fi
CMD="huggingface-cli download $M --local-dir /root/nano --exclude '*.md' && \
vllm serve $SRC --served-model-name $NAME --trust-remote-code \
 --max-model-len 8192 --max-num-seqs 32 --mamba_ssm_cache_dtype float32 \
 --enable-auto-tool-choice --tool-parser-plugin /root/nano/nemotron_toolcall_parser_no_streaming.py --tool-call-parser nemotron_json \
 --host 0.0.0.0 --port 8000"
nebius ai endpoint create --name "scrub-nano-$NAME" \
  --image vllm/vllm-openai:v0.11.0 \
  --container-command bash --args "-c \"$CMD\"" \
  --container-port 8000 \
  --volume "$NEBIUS_S3_BUCKET_ID:/data:ro" \
  --platform "$PLATFORM" --preset "$PRESET" --disk-size 100Gi --shm-size 16Gi \
  --auth token --token "$NANO_API_KEY" --async --format json > "$OUT"
# The create output is the endpoint (metadata.id) or its operation (resource_id).
ID=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("metadata",{}).get("id") or d.get("resource_id") or d["metadata"]["resource_id"])' "$OUT")
echo "endpoint $ID"
URL=""
for _ in $(seq 1 60); do
  URL=$(nebius ai endpoint get "$ID" --format json | python3 -c 'import sys,json;print(next((u for u in json.load(sys.stdin)["status"].get("public_endpoints",[]) if u.startswith("https://")),""))')
  [ -n "$URL" ] && break; sleep 10
done
sed -i '' '/^NANO_BASE_URL=/d; /^NANO_ENDPOINT_ID=/d' .env
printf 'NANO_BASE_URL=%s/v1\nNANO_ENDPOINT_ID=%s\n' "$URL" "$ID" >> .env
echo "NANO_BASE_URL=$URL/v1 (model $NAME); the server needs a few minutes after RUNNING to load"
