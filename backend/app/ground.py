"""The grounding rule (CLAUDE.md 4.2): the agent may not state a number the
engine did not compute this turn.

    grounded = every number in the text matches
                 a numeric value in this turn's tool results (at the precision written), or
                 a number the user typed this turn (a threshold they set), or
                 a small unitless count in ALLOW (step counts: "1", "2")

A number written with k decimals matches a tool value v when round(v, k)
equals it, so "39 %" is grounded by a remnant of 38.6 and "38.6 %" is too,
but "40 %" is not. Signs are dropped on both sides: "moved 5 mm" is grounded
by offset_mm -5. Units are not compared; the model may say "5 mm" of a value
the tool reported in mm, and the tools never report the same quantity in two
units.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

# Digits not glued to a word or a decimal point, so "liver_36", "v2" and
# "Nano-9B" are not read as numbers. Optional unit after an optional space.
NUMBER_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s?(%|mm|mL|ml|°|ms)?(?!\w)")

# DECISION: unitless 0 to 3 are allowed without a source (step and item
# counts: "2 changes", "1 vessel"). Anything larger, or with a unit, needs one.
ALLOW = {0.0, 1.0, 2.0, 3.0}


@dataclass
class GroundResult:
    passed: bool
    numbers: list[str] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def numbers_in(text: str) -> list[tuple[str, str | None]]:
    """Every (number, unit) in the text, in order."""
    return [(m.group(1), m.group(2)) for m in NUMBER_RE.finditer(text or "")]


def numeric_leaves(obj: Any) -> Iterable[float]:
    """Every int/float anywhere inside a tool result. Booleans are not numbers."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        yield float(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from numeric_leaves(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from numeric_leaves(v)


def _decimals(s: str) -> int:
    return len(s.split(".")[1]) if "." in s else 0


def ground_check(text: str, tool_results: list[Any], user_text: str = "") -> GroundResult:
    sources = [abs(v) for v in numeric_leaves(tool_results)]
    sources += [float(n) for n, _ in numbers_in(user_text)]
    found = numbers_in(text)
    rejected: list[str] = []
    for num, unit in found:
        x = float(num)
        k = _decimals(num)
        if unit is None and x in ALLOW:
            continue
        if any(round(v, k) == x for v in sources):
            continue
        rejected.append(num + (f" {unit}" if unit else ""))
    return GroundResult(passed=not rejected, numbers=[n + (f" {u}" if u else "") for n, u in found], rejected=rejected)


def allowed_numbers(tool_results: list[Any], user_text: str = "") -> list[str]:
    """The numbers the model may use, for the regeneration instruction."""
    vals = sorted({round(abs(v), 1) for v in numeric_leaves(tool_results)} | {float(n) for n, _ in numbers_in(user_text)})
    return [f"{v:g}" for v in vals]


# ---------------------------------------------------------------- templates


def _f(v: Any) -> str:
    return f"{v:g}" if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)


def template_reply(results: list[tuple[str, dict[str, Any]]]) -> str:
    """Last resort when the model's text fails twice: one sentence per tool
    result, built only from the result's own fields, so it is grounded by
    construction."""
    out: list[str] = []
    for name, r in results:
        if not isinstance(r, dict) or "error" in r:
            out.append(f"{name.replace('_', ' ').capitalize()} did not complete.")
            continue
        if name == "measure" and "value" in r:
            out.append(f"{str(r.get('what', 'value')).replace('_', ' ').capitalize()}: {_f(r['value'])} {r.get('unit', '')}.".replace(" .", "."))
        elif name in ("set_plane",) and "flr_pct" in r:
            out.append(f"Plane moved. Remnant {_f(r['flr_pct'])} %, margin {_f(r['margin_mm'])} mm, vessels crossed {_f(r['vessels_crossed'])}.")
        elif name == "optimize_plane" and "after" in r:
            b, a = r.get("before", {}), r["after"]
            out.append(
                f"Optimized. Remnant {_f(b.get('flr_pct', '-'))} to {_f(a.get('flr_pct', '-'))} %, "
                f"margin {_f(b.get('margin_mm', '-'))} to {_f(a.get('margin_mm', '-'))} mm, "
                f"vessels crossed {_f(a.get('vessels_crossed', '-'))}."
            )
        elif name in ("place_stent", "optimize_stent") and "seals" in r:
            out.append("Stent placed. It seals." if r["seals"] else "Stent placed. It does not seal.")
        elif name == "optimize_stent" and r.get("found") is False:
            out.append("No valid stent position found.")
        elif name == "resect" and "resected_ml" in r:
            out.append(f"Resected {_f(r['resected_ml'])} mL. Remnant {_f(r['remnant_flr_pct'])} %.")
        else:
            out.append("Done.")
    return " ".join(dict.fromkeys(out)) or "Done."


# ---------------------------------------------------------------- log


def log(metrics_dir: Path, row: dict[str, Any]) -> None:
    metrics_dir.mkdir(parents=True, exist_ok=True)
    with (metrics_dir / "grounding.jsonl").open("a") as f:
        f.write(json.dumps({"ts": time.time(), **row}) + "\n")


def totals(metrics_dir: Path) -> dict[str, int]:
    """Cumulative counter for the HUD: turns that ended grounded, and texts rejected."""
    grounded = rejected = 0
    p = metrics_dir / "grounding.jsonl"
    if p.exists():
        for line in p.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("kind") == "check" and not row.get("passed"):
                rejected += 1
            elif row.get("kind") == "final":
                grounded += 1
    return {"grounded": grounded, "rejected": rejected}
