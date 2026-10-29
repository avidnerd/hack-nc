#!/usr/bin/env bash
# Container entry for the backend endpoint (backend/deploy.sh injects it).
#   bash /srv/boot.sh <owner/repo> <git-sha>
set -euo pipefail
python - "$1" "$2" <<'PY'
import io, sys, tarfile, urllib.request
repo, sha = sys.argv[1:]
data = urllib.request.urlopen(f"https://codeload.github.com/{repo}/tar.gz/{sha}").read()
keep = ("backend/", "shared/", "prompts/", "data/device_rules/")
with tarfile.open(fileobj=io.BytesIO(data)) as t:
    members = [m for m in t.getmembers() if m.name.partition("/")[2].startswith(keep)]
    t.extractall("/srv/src", members=members, filter="data")
PY
mv /srv/src/* /srv/app
cd /srv/app/backend
pip install -q --no-cache-dir 'fastapi>=0.115' 'uvicorn[standard]>=0.30' 'openai>=1.50' 'jsonschema>=4.23' \
  'python-dotenv>=1.0' 'numpy>=2.4' 'scipy>=1.17' 'httpx>=0.27' 'boto3>=1.35'
# Uploaded scans start vista3d-full jobs through the Nebius CLI, as a service
# account whose key is in the scrub-backend secret. Without the key, /api/scans is off.
if [ -n "${NEBIUS_SA_KEY_JSON:-}" ]; then
  python - <<'PY'
import os, urllib.request
base = "https://artifacts.nebius.cloud/cli/release"
v = urllib.request.urlopen(f"{base}/stable").read().decode().strip()
urllib.request.urlretrieve(f"{base}/{v}/linux/x86_64/nebius", "/usr/local/bin/nebius")
os.chmod("/usr/local/bin/nebius", 0o755)
open("/srv/sa.json", "w").write(os.environ["NEBIUS_SA_KEY_JSON"])
PY
  nebius profile create jobs --endpoint api.nebius.cloud --service-account-file /srv/sa.json \
    --parent-id "$VISTA_JOB_PROJECT_ID" >/dev/null
  export NEBIUS_PROFILE=jobs
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'
