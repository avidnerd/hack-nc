"""Run one command end to end with the Python engine executing the tools.

Same rounds as the browser (backend/app/agent.py): the model answers with
tool calls, the engine runs them, the results go back as tool messages, until
a round has no tool calls; that final text is grounded by run_turn. Used by
teach.py (teacher traces) and eval.py (every model in the results table).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import agent  # noqa: E402
from app.engine import Session, execute  # noqa: E402

MAX_ROUNDS = 5


def open_session(cmd: dict[str, Any]) -> Session:
    s = Session.open(cmd["case_id"])
    for name, args in cmd.get("setup", []):
        r = execute(s, name, args)
        if "error" in r:
            raise RuntimeError(f"setup {name} failed: {r['error']}")
    return s


def solve(client: Any, model: str, cmd: dict[str, Any], timeout_s: float = 30.0) -> dict[str, Any]:
    """Returns the full trace: messages, tool calls with results, final text, timing, tokens."""
    s = open_session(cmd)
    state0 = execute(s, "get_state")
    history: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    rounds = []
    t0 = time.perf_counter()
    first_tool_ms = None
    final = None
    error = None
    for _ in range(MAX_ROUNDS):
        try:
            r = agent.run_turn(client, model, cmd["text"], state0, timeout_s, history=history)
        except Exception as e:  # provider error or timeout: the trace fails, the run goes on
            error = f"{type(e).__name__}: {e}"[:300]
            break
        rounds.append({"latency_ms": r.latency_ms, "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens})
        if r.done:
            final = r
            break
        if first_tool_ms is None:
            first_tool_ms = round((time.perf_counter() - t0) * 1000)
        history.append(r.assistant_message)
        for tc in r.tool_calls:
            result = execute(s, tc.name, tc.arguments) if not tc.errors else {"error": "; ".join(tc.errors)}
            calls.append({"name": tc.name, "arguments": tc.arguments, "errors": tc.errors, "result": result})
            history.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})
    else:
        error = "max rounds"

    return {
        "id": cmd["id"],
        "model": model,
        "command": cmd,
        "state0": state0,
        "history": history,
        "calls": calls,
        "text": final.text if final else None,
        "grounding": final.grounding if final else None,
        "final_state": execute(s, "get_state"),
        "final_plan": execute(s, "write_plan"),
        "latency_ms": round((time.perf_counter() - t0) * 1000),
        # "End-to-end from request to final tool call" (CLAUDE.md 5.6): the
        # model's last tool round, excluding the closing sentence.
        "tool_latency_ms": sum(r["latency_ms"] for r in rounds[:-1]) if len(rounds) > 1 else (rounds[0]["latency_ms"] if rounds else None),
        "rounds": rounds,
        "prompt_tokens": sum(r["prompt_tokens"] or 0 for r in rounds),
        "completion_tokens": sum(r["completion_tokens"] or 0 for r in rounds),
        "error": error,
    }
