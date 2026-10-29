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
  'python-dotenv>=1.0' 'numpy>=2.4' 'scipy>=1.17' 'httpx>=0.27'
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'
