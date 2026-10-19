"""Agent turn and tool validation, against a fake OpenAI client (no network)."""

from __future__ import annotations

import json
from types import SimpleNamespace as NS

from app import agent
from app.tools import tool_specs, validate_call


class FakeClient:
    def __init__(self, tool_calls, content=None):
        self.sent = None

        def create(**kw):
            self.sent = kw
            msg = NS(content=content, tool_calls=tool_calls)
            return NS(choices=[NS(message=msg)], usage=NS(prompt_tokens=100, completion_tokens=20))

        self.chat = NS(completions=NS(create=create))


def call(name, args, id_="c1"):
    return NS(id=id_, function=NS(name=name, arguments=json.dumps(args)))


def test_all_thirteen_tools_load():
    names = [t["function"]["name"] for t in tool_specs()]
    assert len(names) == 13 and len(set(names)) == 13
    assert {"optimize_plane", "place_stent", "segment_point", "lookup_device_rules"} <= set(names)


def test_valid_call_passes():
    args, errors = validate_call("optimize_plane", '{"margin_min_mm": 10, "avoid": ["hepatic_vein"]}')
    assert errors == [] and args == {"margin_min_mm": 10, "avoid": ["hepatic_vein"]}


def test_invalid_calls_are_rejected():
    assert validate_call("teleport", "{}")[1] == ["unknown tool 'teleport'"]
    assert validate_call("measure", "{}")[1]  # missing required 'what'
    assert validate_call("measure", '{"what": "iq"}')[1]  # not in enum
    assert validate_call("window", "not json")[1]
    assert validate_call("set_plane", '{"normal": [1, 0]}')[1]  # wrong length
    assert validate_call("set_plane", '{"teleport": 1}')[1]  # extra key


def test_turn_sends_tools_at_temperature_zero_and_validates():
    fake = FakeClient([call("optimize_plane", {"margin_min_mm": 10})])
    r = agent.run_turn(fake, "m", "optimize with a 10 mm margin", {"case_id": "liver"}, 6.0)
    assert fake.sent["temperature"] == 0
    assert len(fake.sent["tools"]) == 13
    assert any("liver" in m["content"] for m in fake.sent["messages"] if m["role"] == "system")
    assert r.valid and r.tool_calls[0].name == "optimize_plane" and r.tool_calls[0].arguments == {"margin_min_mm": 10}
    assert r.prompt_tokens == 100


def test_turn_flags_a_bad_tool_call():
    r = agent.run_turn(FakeClient([call("measure", {"what": "iq"})]), "m", "x", None, 6.0)
    assert not r.valid and r.tool_calls[0].arguments is None and r.tool_calls[0].errors
