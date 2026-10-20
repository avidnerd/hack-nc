"""Verified traces -> chat SFT files for the LoRA job.

    cd backend && uv run python ../distill/export_sft.py distill/data/traces_<teacher>_verified.jsonl

Only kept traces go in (verify.py). Each example is the exact message list the
student will see at runtime (system prompt, state, user, then the teacher's
tool rounds and tool results, then the final grounded text), plus the tool
schemas, so the chat template renders tools the same way vLLM will.

Writes distill/data/sft_train.jsonl and sft_val.jsonl, split by the command's
split; test commands are never exported.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import agent  # noqa: E402
from app.tools import tool_specs  # noqa: E402

DATA = ROOT / "distill" / "data"


def example(trace: dict) -> dict:
    cmd = trace["command"]
    msgs = agent.build_messages(cmd["text"], trace["state0"], trace["history"])
    msgs.append({"role": "assistant", "content": trace["text"]})
    return {"id": trace["id"], "template": cmd["template"], "messages": msgs, "tools": tool_specs()}


def main() -> int:
    src = Path(sys.argv[1])
    rows = [json.loads(ln) for ln in src.read_text().splitlines() if ln.strip()]
    out = {"train": [], "val": []}
    for t in rows:
        split = t["command"]["split"]
        if t["verify"]["keep"] and split in out:
            out[split].append(example(t))
    for split, exs in out.items():
        with (DATA / f"sft_{split}.jsonl").open("w") as f:
            for e in exs:
                f.write(json.dumps(e) + "\n")
        print(f"{split}: {len(exs)} examples -> distill/data/sft_{split}.jsonl")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
