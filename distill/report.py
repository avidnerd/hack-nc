"""Agent results table for docs/RESULTS.md, from metrics/results.json.

    python3 distill/report.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

LABELS = {
    "super": "Nemotron 3 Super (Token Factory)",
    "nano-tf": "Nemotron 3 Nano 30B A3B, few-shot (Token Factory)",
    "nano": "Nemotron Nano 9B v2, base (our Nebius endpoint)",
    "nano-lora": "Nemotron Nano 9B v2 + our LoRA (our Nebius endpoint)",
    "router": "Router: Nano-LoRA first, Super on escalation",
}
ORDER = ["super", "nano-tf", "nano", "nano-lora", "router"]


def pct(v: float | None) -> str:
    return "—" if v is None else f"{v * 100:.1f} %"


def ms(v: float | None) -> str:
    return "—" if v is None else f"{v / 1000:.1f} s"


def usd(v: float | None) -> str:
    return "—" if v is None else f"${v:.2f}"


def section() -> str:
    data = json.loads((ROOT / "metrics" / "results.json").read_text())
    rows = {r["name"]: r for r in data["models"]}
    n = next(iter(rows.values()))["n"] if rows else 0
    lines = []
    for key in ORDER:
        r = rows.get(key)
        if r is None:
            lines.append(f"| {LABELS[key]} | — | — | — | — | — | — |")
            continue
        lines.append(
            f"| {LABELS[key]} | {pct(r['success'])} | {pct(r['schema_valid'])} | {pct(r['grounded'])} "
            f"| {ms(r['latency_ms_median'])} | {ms(r['latency_ms_p95'])} | {usd(r['cost_per_1k_usd'])} |"
        )
    methods = "\n".join(f"- {LABELS.get(k, k)}: {rows[k]['cost_method']}." for k in ORDER if k in rows)
    return f"""## Agent: success, latency and cost on held-out commands

Source: `metrics/results.json` (`make eval`). {n} test commands that no model was trained on, each run end to end with the Python engine executing every tool call, scored by the same verifier that filtered the training data:

- **Task success**: the command's goal predicate holds on the final engine state (for example `margin >= 10 and vessels_crossed == 0`).
- **Schema valid**: every tool call matched its JSON schema.
- **Grounded**: every number in the model's own final reply came from a tool result this turn (`ground_check`), without a rewrite or template fallback.
- **Latency**: request to final tool call, end to end.

| Model | Task success | Schema valid | Grounded | Median latency | p95 latency | Cost per 1,000 commands |
|---|---|---|---|---|---|---|
{chr(10).join(lines)}

Cost method:
{methods}
{router_note(rows)}
Network faults: rows that failed with a connection error or a 30 s timeout at our endpoint's public tunnel are rerun (`distill/retry_transport.py`); model failures keep their rows. Superseded runs are in `distill/data/archive/` and their GPU time stays in `metrics/spend.jsonl`.
"""


def router_note(rows: dict) -> str:
    r = rows.get("router")
    if not r or r.get("escalated_commands") is None:
        return ""
    why = ", ".join(f"{k} {v}" for k, v in sorted(r["escalation_reasons"].items(), key=lambda kv: -kv[1])) or "none"
    return (f"\nRouter: {pct(r['escalated_commands'])} of commands escalated to Super at least once; "
            f"Nano-LoRA answered {pct(r['nano_rounds'])} of rounds. Escalation reasons (rounds): {why}.\n")


if __name__ == "__main__":
    print(section())
