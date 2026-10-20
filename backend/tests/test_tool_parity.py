"""Tool parity, Python half: replays tests/fixtures/tool_script.json through
the Python executor and requires the JSON the browser's TS executor produced
for the same calls (tests/fixtures/tool_parity_ts.json, written by
e2e/toolParity.spec.ts; `make tool-parity` regenerates it and runs this).

A model distilled on Python results runs against the TS executor, so the two
must agree key for key: same keys, same strings (errors included), same
booleans and integers, and numbers equal after the documented rounding
(docs/TOOLS.md). Keys where the two sides do the same maths in a different
float order may differ by one rounding step; they are listed in TOLERANT
with the reason, and nothing else gets a tolerance.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.config import REPO
from app.engine import Session, execute

FIXTURES = REPO / "tests" / "fixtures"
SCRIPT = json.loads((FIXTURES / "tool_script.json").read_text())
TS = json.loads((FIXTURES / "tool_parity_ts.json").read_text())

# Key name -> allowed absolute difference. Every entry needs a reason.
TOLERANT: dict[str, float] = {}


def diff(got: Any, want: Any, path: str = "$") -> list[str]:
    """Every place `got` (Python) and `want` (TS) differ, as readable paths."""
    if isinstance(want, dict):
        if not isinstance(got, dict):
            return [f"{path}: python {got!r}, ts {want!r}"]
        out = []
        for k in sorted(set(got) | set(want)):
            if k not in got:
                out.append(f"{path}.{k}: missing in python (ts {want[k]!r})")
            elif k not in want:
                out.append(f"{path}.{k}: extra in python ({got[k]!r})")
            else:
                out += diff(got[k], want[k], f"{path}.{k}")
        return out
    if isinstance(want, list):
        if not isinstance(got, list) or len(got) != len(want):
            return [f"{path}: python {got!r}, ts {want!r}"]
        return [d for i, (g, w) in enumerate(zip(got, want)) for d in diff(g, w, f"{path}[{i}]")]
    if isinstance(want, bool) or isinstance(got, bool) or want is None or got is None or isinstance(want, str):
        return [] if got == want and type(got) is type(want) else [f"{path}: python {got!r}, ts {want!r}"]
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        key = path.rsplit(".", 1)[-1].split("[")[0]
        if got == want or abs(got - want) <= TOLERANT.get(key, 0) + 1e-9:
            return []
        return [f"{path}: python {got!r}, ts {want!r}"]
    return [f"{path}: python {got!r}, ts {want!r}"]


def test_fixture_matches_script() -> None:
    assert [s["case"] for s in TS["sections"]] == [s["case"] for s in SCRIPT["sections"]]
    for ts, sc in zip(TS["sections"], SCRIPT["sections"]):
        assert len(ts["results"]) == len(sc["calls"]), "re-run `make tool-parity`: the script changed"


@pytest.mark.parametrize("i", range(len(SCRIPT["sections"])), ids=lambda i: f"{SCRIPT['sections'][i]['case']}-{i}")
def test_section(i: int) -> None:
    section = SCRIPT["sections"][i]
    want = TS["sections"][i]["results"]
    s = Session.open(section["case"])
    problems = []
    for j, (call, w) in enumerate(zip(section["calls"], want)):
        got = execute(s, call["tool"], call["args"])
        for d in diff(got, w):
            problems.append(f"call {j} {call['tool']} {json.dumps(call['args'])}: {d}")
    assert not problems, "\n".join(problems)
