#!/usr/bin/env bash
# Start the scrub-nano Serverless Endpoint: vLLM serving Nemotron Nano 9B v2
# (model name "base") and our LoRA (model name "scrub") from one GPU, behind
# an OpenAI-compatible API with a bearer token.
#   bash distill/serve/launch.sh <run>          e.g. lora-1024-1328
# Writes NANO_BASE_URL and NANO_API_KEY to .env once the endpoint is up.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
RUN=${1:?training run name under /data/distill/runs}
PLATFORM=${2:-gpu-h100-sxm}; PRESET=${3:-1gpu-16vcpu-200gb}
if [ -z "${NANO_API_KEY:-}" ]; then
  NANO_API_KEY=$(openssl rand -hex 24)
  printf '\n# scrub-nano endpoint bearer token\nNANO_API_KEY=%s\n' "$NANO_API_KEY" >> .env
fi
M=nvidia/NVIDIA-Nemotron-Nano-9B-v2
OUT=$(mktemp)
# The tool-call parser plugin ships in the model repo, so the weights are
# fetched to local disk first and served from there (flags from the model card).
CMD="huggingface-cli download $M --local-dir /root/nano --exclude '*.md' && \
vllm serve /root/nano --served-model-name base --trust-remote-code \
 --max-model-len 8192 --max-num-seqs 32 --mamba_ssm_cache_dtype float32 \
 --enable-auto-tool-choice --tool-parser-plugin /root/nano/nemotron_toolcall_parser_no_streaming.py --tool-call-parser nemotron_json \
 --enable-lora --max-lora-rank 16 --lora-modules scrub=/data/distill/runs/$RUN/scrub-lora \
 --host 0.0.0.0 --port 8000"
nebius ai endpoint create --name scrub-nano \
  --image vllm/vllm-openai:v0.11.0 \
  --container-command bash --args "-c \"$CMD\"" \
  --container-port 8000 \
  --volume "$NEBIUS_S3_BUCKET_ID:/data:ro" \
  --platform "$PLATFORM" --preset "$PRESET" --disk-size 100Gi --shm-size 16Gi \
  --auth token --token "$NANO_API_KEY" --format json > "$OUT"
ID=$(python3 -c 'import json;print(json.load(open("'$OUT'"))["metadata"]["id"])')
echo "endpoint $ID"
URL=$(nebius ai endpoint get "$ID" --format json | python3 -c 'import sys,json;print(next(u for u in json.load(sys.stdin)["status"].get("public_endpoints",[]) if u.startswith("https://")))')
grep -q '^NANO_BASE_URL=' .env && sed -i '' "s|^NANO_BASE_URL=.*|NANO_BASE_URL=$URL/v1|" .env || printf 'NANO_BASE_URL=%s/v1\nNANO_ENDPOINT_ID=%s\n' "$URL" "$ID" >> .env
echo "NANO_BASE_URL=$URL/v1"
