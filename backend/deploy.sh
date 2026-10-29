#!/usr/bin/env bash
# Deploy the FastAPI backend as a CPU Nebius Serverless Endpoint.
#   bash backend/deploy.sh [git-sha]     (default: HEAD, which must be pushed)
#
# DECISION: no image build. The public python:3.11-slim image runs
# backend/bootstrap.sh (injected), which downloads this repo at one pinned
# commit from GitHub, installs the backend's dependencies and runs uvicorn. Same pattern as the
# VISTA-3D Job: no registry or Docker on the critical path.
# Keys live in one SecretStash secret (scrub-backend), passed with --env-secret.
# Writes BACKEND_URL and BACKEND_ENDPOINT_ID to .env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
SHA=${1:-$(git rev-parse HEAD)}
# eu-south1 has non-GPU vCPU quota; eu-north1 has none (docs/PLATFORM_NOTES.md).
PROJECT=${BACKEND_PROJECT_ID:-project-e07gy4etma00qzp4yapzqb}
# Space separated: a comma would split the --env value.
ORIGINS=${BACKEND_ORIGINS:-https://scrubplus.vercel.app http://localhost:5173}
REPO=${BACKEND_REPO:-avidnerd/hack-nc}
SECRET=scrub-backend

payload=$(python3 - <<'EOF'
import json, os
keys = ["NEBIUS_TF_API_KEY", "TAVILY_API_KEY", "NANO_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
vals = {k: os.environ[k] for k in keys if os.environ.get(k)}
# The job-launching service account key (see docs/OPERATIONS.md), if present.
key = os.environ.get("NEBIUS_SA_KEY_FILE")
if key and os.path.exists(key):
    vals["NEBIUS_SA_KEY_JSON"] = open(key).read()
print(json.dumps([{"key": k, "string_value": v} for k, v in vals.items()]))
EOF
)
SID=$(nebius mysterybox secret list --parent-id "$PROJECT" --format json | python3 -c 'import json,sys;print(next((s["metadata"]["id"] for s in json.load(sys.stdin).get("items",[]) if s["metadata"]["name"]=="'$SECRET'"),""))')
if [ -z "$SID" ]; then
  nebius mysterybox secret create --parent-id "$PROJECT" --name "$SECRET" --secret-version-payload "$payload" >/dev/null
else
  nebius mysterybox secret-version create --parent-id "$SID" --payload "$payload" --set-primary >/dev/null
fi

ENVS=(--env "NEBIUS_TF_BASE_URL=$NEBIUS_TF_BASE_URL" --env "NEBIUS_TF_MODEL_SUPER=$NEBIUS_TF_MODEL_SUPER"
  --env METRICS_DIR=/tmp/metrics --env "DAILY_BUDGET_USD=${DAILY_BUDGET_USD:-15}" --env AGENT_RPM=30 --env RULES_RPM=3
  --env "ALLOWED_ORIGINS=$ORIGINS")
[ -n "${NANO_BASE_URL:-}" ] && ENVS+=(--env "NANO_BASE_URL=$NANO_BASE_URL")
SECRETS=(--env-secret "NEBIUS_TF_API_KEY=$SECRET" --env-secret "TAVILY_API_KEY=$SECRET" --env-secret "NANO_API_KEY=$SECRET")
# Uploaded scans: bucket keys, and the service account key that starts the vista3d-full job.
if [ -n "${NEBIUS_SA_KEY_FILE:-}" ] && [ -f "$NEBIUS_SA_KEY_FILE" ]; then
  ENVS+=(--env "VISTA_JOB_PROJECT_ID=$VISTA_JOB_PROJECT_ID" --env "NEBIUS_S3_ENDPOINT=$NEBIUS_S3_ENDPOINT"
    --env "NEBIUS_S3_BUCKET=$NEBIUS_S3_BUCKET" --env "NEBIUS_S3_BUCKET_ID=$NEBIUS_S3_BUCKET_ID"
    --env "AWS_DEFAULT_REGION=$AWS_DEFAULT_REGION" --env "SCANS_PER_HOUR=${SCANS_PER_HOUR:-3}" --env "SCANS_PER_DAY=${SCANS_PER_DAY:-20}")
  SECRETS+=(--env-secret "AWS_ACCESS_KEY_ID=$SECRET" --env-secret "AWS_SECRET_ACCESS_KEY=$SECRET" --env-secret "NEBIUS_SA_KEY_JSON=$SECRET")
fi
OUT=$(mktemp)
nebius ai endpoint create --parent-id "$PROJECT" --name scrub-backend \
  --image python:3.11-slim \
  --inject-file backend/bootstrap.sh:/srv/boot.sh \
  --container-command bash --args "/srv/boot.sh $REPO $SHA" \
  --container-port 8000 \
  --platform cpu-d3 --preset 2vcpu-8gb --disk-size 20Gi \
  "${ENVS[@]}" \
  "${SECRETS[@]}" \
  --async --format json > "$OUT"
ID=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("metadata",{}).get("id") or d.get("resource_id") or d["metadata"]["resource_id"])' "$OUT")
echo "endpoint $ID (commit $SHA)"
URL=""
for _ in $(seq 1 60); do
  URL=$(nebius ai endpoint get "$ID" --format json | python3 -c 'import sys,json;print(next((u for u in json.load(sys.stdin)["status"].get("public_endpoints",[]) if u.startswith("https://")),""))')
  [ -n "$URL" ] && break; sleep 10
done
sed -i '' '/^BACKEND_URL=/d; /^BACKEND_ENDPOINT_ID=/d' .env
printf 'BACKEND_URL=%s\nBACKEND_ENDPOINT_ID=%s\n' "$URL" "$ID" >> .env
echo "BACKEND_URL=$URL"
