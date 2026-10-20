"""A scripted perfect policy, as a fake OpenAI client.

It reads the command's template and slots and answers with the tool calls a
correct agent would make, then a template sentence built from the results.
Running it through loop.solve + verify.verify checks the pipeline itself:
every goal predicate must be reachable, so the oracle's keep rate should be
100 %. Anything less is a bug in a template, not in a model.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace as NS
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import ground  # noqa: E402


def plan_for(cmd: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    t, s = cmd["template"], cmd.get("slots", {})
    dev = "generic"
    return {
        "opt_margin": lambda: [("optimize_plane", {"margin_min_mm": s["m"]})],
        "opt_flr": lambda: [("optimize_plane", {"flr_min_pct": s["p"]})],
        "opt_avoid": lambda: [("optimize_plane", {"avoid": [s["vid"]]})],
        "opt_plain": lambda: [("optimize_plane", {})],
        "m_flr": lambda: [("measure", {"what": "flr"})],
        "m_margin": lambda: [("measure", {"what": "margin"})],
        "m_vessels": lambda: [("measure", {"what": "vessels_crossed"})],
        "m_tumor": lambda: [("measure", {"what": "tumor_volume"})],
        "nudge": lambda: [("set_plane", {"offset_mm": s["k"]})],
        "rotate": lambda: [("set_plane", {"rotate_deg": {"axis": s["axis"], "deg": s["deg"]}})],
        "thr_margin": lambda: [("set_threshold", {"name": "margin_min_mm", "value": s["m"]})],
        "thr_flr": lambda: [("set_threshold", {"name": "flr_min_pct", "value": s["p"]})],
        "resect": lambda: [("resect", {})],
        "show_iso": lambda: [("show", {"structure_ids": [s["sid"]], "mode": "isolate"})],
        "hide": lambda: [("show", {"structure_ids": [s["sid"]], "mode": "hide"})],
        "window": lambda: [("window", {"preset": s["w"]})],
        "plan": lambda: [("write_plan", {})],
        "multi_opt_resect": lambda: [("optimize_plane", {"margin_min_mm": s["m"]}), ("resect", {})],
        "multi_thr_opt": lambda: [("optimize_plane", {"margin_min_mm": s["m"], "flr_min_pct": s["p"]})],
        "clarify": lambda: [],
        "clarify_aorta": lambda: [],
        "stent": lambda: [("place_stent", {"device_id": dev})],
        "stent_at": lambda: [("place_stent", {"device_id": dev, "s0_mm": s["s"]})],
        "stent_opt": lambda: [("optimize_stent", {"device_id": dev})],
        "neck": lambda: [("measure", {"what": "neck_diameter" if "diameter" in cmd["text"] else "neck_length"})],
    }[t]()


class OracleClient:
    def __init__(self, cmd: dict[str, Any]):
        calls = plan_for(cmd)

        def create(**kw: Any) -> Any:
            msgs = kw["messages"]
            if not any(m.get("role") == "tool" for m in msgs) and calls:
                tcs = [NS(id=f"o{i}", function=NS(name=n, arguments=json.dumps(a))) for i, (n, a) in enumerate(calls)]
                msg = NS(content=None, tool_calls=tcs)
            elif not calls:
                msg = NS(content="Which matters more here, margin or remnant?", tool_calls=None)
            else:
                names = {tc["id"]: tc["function"]["name"] for m in msgs for tc in (m.get("tool_calls") or [])}
                res = [(names[m["tool_call_id"]], json.loads(m["content"])) for m in msgs if m.get("role") == "tool"]
                msg = NS(content=ground.template_reply(res), tool_calls=None)
            return NS(choices=[NS(message=msg)], usage=NS(prompt_tokens=0, completion_tokens=0))

        self.chat = NS(completions=NS(create=create))
