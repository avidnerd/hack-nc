"""The distillation pipeline checks itself: the scripted perfect policy must
pass the verifier on every generated command, and a wrong answer must not."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "distill"))

import loop  # noqa: E402
import oracle  # noqa: E402
import verify  # noqa: E402

COMMANDS = ROOT / "distill" / "data" / "commands.jsonl"


@pytest.fixture(scope="module")
def commands():
    subprocess.run([sys.executable, str(ROOT / "distill" / "gen_commands.py")], check=True, capture_output=True)
    return [json.loads(ln) for ln in COMMANDS.read_text().splitlines()]


def one_per_template(commands):
    seen = {}
    for c in commands:
        seen.setdefault((c["template"], json.dumps(c["setup"]) == json.dumps([["set_plane", {"offset_mm": 0}]])), c)
    return list(seen.values())


def test_generator_covers_every_template_and_split(commands):
    from templates import TEMPLATES

    assert {c["template"] for c in commands} == {t.id for t in TEMPLATES}
    assert {"train", "val", "test"} <= {c["split"] for c in commands}
    assert len({c["id"] for c in commands}) == len(commands)


def test_oracle_passes_every_template(commands):
    failed = []
    for cmd in one_per_template(commands):
        trace = loop.solve(oracle.OracleClient(cmd), "oracle", cmd)
        v = verify.verify(trace)
        if not v["keep"]:
            failed.append((cmd["template"], cmd["text"], v["reasons"], trace["text"], trace["error"]))
    assert not failed, failed


def test_wrong_answer_is_rejected(commands):
    cmd = next(c for c in commands if c["template"] == "opt_margin")
    wrong = {**cmd, "template": "m_flr"}  # measures instead of optimizing
    trace = loop.solve(oracle.OracleClient(wrong), "oracle", cmd)
    assert verify.verify(trace)["reasons"] == ["goal"]


def test_clarify_that_changes_the_plan_is_rejected(commands):
    cmd = next(c for c in commands if c["template"] == "clarify")
    trace = loop.solve(oracle.OracleClient({**cmd, "template": "opt_plain"}), "oracle", cmd)
    assert "goal" in verify.verify(trace)["reasons"]
