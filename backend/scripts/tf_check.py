"""M0 platform check for Token Factory. Run once the key is in .env:

    cd backend && uv run python scripts/tf_check.py

1. GET /v1/models -> metrics/tf_models.json (every id), prints the Nemotron ones.
2. If NEBIUS_TF_MODEL_SUPER is set: one tool-calling request through app.agent,
   printed and logged to metrics/agent_requests.jsonl. This is the M0 check.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openai import OpenAI  # noqa: E402

from app import agent, config  # noqa: E402

s = config.load()
if not s.tf_api_key:
    sys.exit("NEBIUS_TF_API_KEY is not set (.env)")
client = OpenAI(api_key=s.tf_api_key, base_url=s.tf_base_url, max_retries=0)

models = client.models.list()
rows = [m.model_dump() for m in models.data]
s.metrics_dir.mkdir(parents=True, exist_ok=True)
(s.metrics_dir / "tf_models.json").write_text(json.dumps(rows, indent=2) + "\n")
print(f"{len(rows)} models at {s.tf_base_url}; written to metrics/tf_models.json")
for r in rows:
    if "nemotron" in r["id"].lower():
        print("  ", r["id"])

if not s.model_super:
    sys.exit("Set NEBIUS_TF_MODEL_SUPER to one of the ids above, then rerun for the tool-call check.")
text = "Optimize the cut with at least a 10 mm margin and keep off the hepatic vein."
res = agent.run_turn(client, s.model_super, text, {"case_id": "liver", "mode": "surgeon"}, s.super_timeout_s)
agent.log_request(s, text, res)
print(json.dumps(res.to_json(), indent=2))
sys.exit(0 if res.valid and res.tool_calls else 1)
