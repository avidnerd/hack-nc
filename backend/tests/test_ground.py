"""ground_check and the final-round grounding loop (no network)."""

from __future__ import annotations

import json
from types import SimpleNamespace as NS

from app import agent, ground

OPT = {
    "plane": {"normal": [0.0, 0.0, 1.0], "d": 112.4},
    "before": {"flr_pct": 31.2, "margin_mm": 4.1, "vessels_crossed": 1},
    "after": {"flr_pct": 38.6, "margin_mm": 10.3, "vessels_crossed": 0},
    "feasible": True,
    "reason_codes": ["margin"],
    "angle_deg": 7.5,
    "offset_mm": -5.0,
}


def test_numbers_are_extracted_with_units():
    got = ground.numbers_in("Remnant 31.2 % to 38.6%, margin 10 mm, 2 vessels, 7.5°")
    assert got == [("31.2", "%"), ("38.6", "%"), ("10", "mm"), ("2", None), ("7.5", "°")]


def test_identifiers_are_not_numbers():
    assert ground.numbers_in("liver_36 on Nano-9B v2 in 3D") == []


def test_tool_values_ground_at_written_precision():
    r = ground.ground_check("Remnant went from 31.2 % to 39 %, margin 10.3 mm.", [OPT])
    assert r.passed, r.rejected


def test_planted_fake_number_is_rejected():
    r = ground.ground_check("Remnant is now 42 % with a 10.3 mm margin.", [OPT])
    assert not r.passed and r.rejected == ["42 %"]


def test_sign_dropped_and_user_numbers_allowed():
    assert ground.ground_check("Moved 5 mm toward the tumor.", [OPT]).passed
    assert ground.ground_check("Margin target is 12 mm.", [OPT], user_text="keep a 12 mm margin").passed
    assert not ground.ground_check("Margin target is 12 mm.", [OPT]).passed


def test_small_unitless_counts_allowed_but_not_with_units():
    assert ground.ground_check("I made 2 changes.", []).passed
    assert not ground.ground_check("Margin is 2 mm.", []).passed


def test_booleans_are_not_numbers():
    assert list(ground.numeric_leaves({"seals": True, "x": 3})) == [3.0]


def test_template_is_grounded_by_construction():
    text = ground.template_reply([("optimize_plane", OPT), ("resect", {"resected_ml": 412.0, "remnant_flr_pct": 38.6})])
    assert ground.ground_check(text, [OPT, {"resected_ml": 412.0, "remnant_flr_pct": 38.6}]).passed


# ---------------------------------------------------------------- loop


class ScriptedClient:
    """Returns the scripted messages in order and records each request."""

    def __init__(self, *messages):
        self.queue = list(messages)
        self.sent = []

        def create(**kw):
            self.sent.append(kw)
            return NS(choices=[NS(message=self.queue.pop(0))], usage=NS(prompt_tokens=50, completion_tokens=10))

        self.chat = NS(completions=NS(create=create))


def history_with(result):
    return [
        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "optimize_plane", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": json.dumps(result)},
    ]


def test_tool_round_returns_assistant_message():
    tc = NS(id="c1", function=NS(name="optimize_plane", arguments='{"margin_min_mm": 10}'))
    r = agent.run_turn(ScriptedClient(NS(content=None, tool_calls=[tc])), "m", "optimize", None, 6.0)
    assert not r.done and r.assistant_message["tool_calls"][0]["function"]["name"] == "optimize_plane"


def test_grounded_final_passes(tmp_path):
    c = ScriptedClient(NS(content="Remnant 38.6 %, margin 10.3 mm.", tool_calls=None))
    r = agent.run_turn(c, "m", "optimize", None, 6.0, history=history_with(OPT), metrics_dir=tmp_path)
    assert r.done and r.text == "Remnant 38.6 %, margin 10.3 mm."
    assert r.grounding["passed"] and r.grounding["rejected"] == 0
    assert ground.totals(tmp_path) == {"grounded": 1, "rejected": 0}


def test_fake_number_is_regenerated(tmp_path):
    c = ScriptedClient(
        NS(content="Remnant is 45 %.", tool_calls=None),
        NS(content="Remnant is 38.6 %.", tool_calls=None),
    )
    r = agent.run_turn(c, "m", "optimize", None, 6.0, history=history_with(OPT), metrics_dir=tmp_path)
    assert r.text == "Remnant is 38.6 %." and r.grounding == {**r.grounding, "passed": True, "rejected": 1, "fallback": False}
    assert "38.6" in c.sent[1]["messages"][-1]["content"] and c.sent[1]["tool_choice"] == "none"
    assert ground.totals(tmp_path) == {"grounded": 1, "rejected": 1}


def test_two_failures_fall_back_to_template(tmp_path):
    c = ScriptedClient(NS(content="Remnant is 45 %.", tool_calls=None), NS(content="Remnant is 46 %.", tool_calls=None))
    r = agent.run_turn(c, "m", "optimize", None, 6.0, history=history_with(OPT), metrics_dir=tmp_path)
    assert r.grounding["fallback"] and r.grounding["passed"] and r.grounding["rejected"] == 2
    assert "38.6" in r.text and "45" not in r.text
    assert ground.totals(tmp_path) == {"grounded": 1, "rejected": 2}


def test_grounding_endpoint_reads_totals(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setattr(main, "settings", main.settings.__class__(**{**main.settings.__dict__, "metrics_dir": tmp_path}))
    ground.log(tmp_path, {"kind": "check", "passed": False})
    ground.log(tmp_path, {"kind": "final", "passed": True})
    assert TestClient(main.app).get("/api/grounding").json() == {"grounded": 1, "rejected": 1}
