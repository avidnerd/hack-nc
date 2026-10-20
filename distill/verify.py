"""Keep a trace only if the engine agrees it is right (CLAUDE.md section 5.3).

    keep = (a) every tool call is schema-valid
           (b) the command's goal predicate holds on the finished engine state
           (c) the final text passed ground_check on the model's own words
               (a template fallback does not count: it is not the model's text)

This is the core of the pipeline: the engine labels the data, so the
training set is verified rather than just generated.

    cd backend && uv run python ../distill/verify.py distill/data/traces_super.jsonl
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import ground  # noqa: E402

# Tools that change the plan; a clarifying reply must call none of them.
MUTATING = {"set_plane", "optimize_plane", "place_stent", "optimize_stent", "set_threshold", "resect", "show", "window"}


def _matches(actual: Any, want: Any) -> bool:
    if isinstance(want, float | int) and isinstance(actual, float | int) and not isinstance(want, bool):
        return math.isclose(actual, want, abs_tol=1e-6)
    if isinstance(want, list) and isinstance(actual, list):
        return sorted(map(str, actual)) == sorted(map(str, want))
    if isinstance(want, dict) and isinstance(actual, dict):
        return all(k in actual and _matches(actual[k], v) for k, v in want.items())
    return actual == want


def goal_env(trace: dict[str, Any]) -> dict[str, Any]:
    calls = trace["calls"]
    ok_calls = [c for c in calls if not c["errors"] and "error" not in c["result"]]
    text = trace.get("text") or ""

    def called(name: str, **args: Any) -> bool:
        return any(c["name"] == name and all(_matches((c["arguments"] or {}).get(k), v) for k, v in args.items()) for c in ok_calls)

    def result(name: str) -> dict[str, Any]:
        for c in reversed(ok_calls):
            if c["name"] == name:
                return c["result"]
        return {}

    def said(x: Any) -> bool:
        if not isinstance(x, int | float):
            return False
        return any(round(abs(float(x)), ground._decimals(n)) == float(n) for n, _ in ground.numbers_in(text))

    p0 = (trace["state0"] or {}).get("plane")
    p1 = (trace["final_state"] or {}).get("plane")
    d_moved = abs(p1["d"] - p0["d"]) if p0 and p1 and p0["normal"] == p1["normal"] else (math.inf if p0 != p1 else 0.0)

    return {
        "called": called,
        "result": result,
        "said": said,
        "th": trace["final_state"]["thresholds"],
        "state": trace["final_state"],
        "plan": trace["final_plan"],
        "clarified": text.strip().endswith("?") and not any(c["name"] in MUTATING for c in calls),
        "d_moved": d_moved,
        "abs": abs,
    }


def verify(trace: dict[str, Any]) -> dict[str, Any]:
    reasons = []
    if trace.get("error"):
        reasons.append("error")
    if any(c["errors"] for c in trace["calls"]):
        reasons.append("schema")
    try:
        goal_ok = bool(eval(trace["command"]["goal"], {"__builtins__": {}}, goal_env(trace)))  # noqa: S307 (our own templates)
    except Exception as e:
        goal_ok = False
        reasons.append(f"goal_error:{type(e).__name__}")
    if not goal_ok:
        reasons.append("goal")
    g = trace.get("grounding") or {}
    if not g.get("passed") or g.get("fallback") or g.get("rejected"):
        reasons.append("grounding")
    return {"keep": not reasons, "reasons": reasons, "goal": goal_ok, "schema_valid": "schema" not in reasons, "grounded": "grounding" not in reasons}


def main() -> int:
    src = Path(sys.argv[1])
    rows = [json.loads(ln) for ln in src.read_text().splitlines() if ln.strip()]
    out = src.with_name(src.stem + "_verified.jsonl")
    kept = 0
    from collections import Counter

    why = Counter()
    with out.open("w") as f:
        for t in rows:
            v = verify(t)
            kept += v["keep"]
            why.update(v["reasons"])
            f.write(json.dumps({**t, "verify": v}) + "\n")
    print(f"kept {kept}/{len(rows)} ({kept / max(len(rows), 1):.1%}) -> {out}")
    print("reject reasons:", dict(why))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
