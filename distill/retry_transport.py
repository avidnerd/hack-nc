"""Drop eval rows that failed on the network (not the model), so `eval.py run` reruns them.

    python distill/retry_transport.py nano-lora      prints how many rows it dropped

Only APIConnectionError and APITimeoutError are dropped; a model that answers
badly, calls an invalid tool or runs out of rounds keeps its row.
"""

import json
import sys
from pathlib import Path

TRANSPORT = ("APIConnectionError", "APITimeoutError")
f = Path(__file__).resolve().parent / "data" / f"eval_{sys.argv[1]}.jsonl"
rows = [json.loads(ln) for ln in f.read_text().splitlines() if ln.strip()]
keep = [r for r in rows if not (r.get("error") or "").startswith(TRANSPORT)]
f.write_text("".join(json.dumps(r) + "\n" for r in keep))
print(len(rows) - len(keep))
