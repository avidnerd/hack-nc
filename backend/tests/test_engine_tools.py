"""Every agent tool against the Python engine: result shapes (docs/TOOLS.md),
state changes, and errors returned rather than raised."""

from __future__ import annotations

import json

import pytest

from app.engine import Session, execute
from app.tools import tool_specs


@pytest.fixture
def liver() -> Session:
    return Session.open("liver")


@pytest.fixture
def aorta() -> Session:
    return Session.open("aorta")


def _is_1dp(x: float) -> bool:
    return round(x, 1) == x


def test_every_schema_tool_has_an_executor(liver: Session) -> None:
    for spec in tool_specs():
        out = execute(liver, spec["function"]["name"], {"__bogus": 1})
        # Schema rejects the bogus arg, so every tool answers with an error dict.
        assert "error" in out
    assert execute(liver, "no_such_tool", {}) == {"error": 'unknown tool "no_such_tool"'}


def test_results_are_json(liver: Session) -> None:
    execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    for name, args in [("get_state", {}), ("measure", {"what": "flr"}), ("write_plan", {}), ("resect", {})]:
        json.dumps(execute(liver, name, args))


def test_get_state_defaults(liver: Session) -> None:
    st = execute(liver, "get_state", {})
    assert st["case_id"] == "liver"
    assert st["case_kind"] == "liver"
    assert st["mode"] == "surgeon"
    assert st["plane"] is None
    assert st["stent"] is None
    assert st["thresholds"] == {"margin_min_mm": 10.0, "flr_min_pct": 30.0}
    assert "liver" in st["visible"] and "tumor" in st["visible"]


def test_aorta_hides_hepatic_tree(aorta: Session) -> None:
    vis = execute(aorta, "get_state", {})["visible"]
    assert "hepatic_vessels" not in vis and "portal_vein" not in vis and "aorta" in vis


def test_set_plane_absolute(liver: Session) -> None:
    out = execute(liver, "set_plane", {"normal": [2, 0, 0], "d": 340})
    assert out["plane"] == {"normal": [1.0, 0.0, 0.0], "d": 340.0}
    assert set(out) == {"plane", "flr_pct", "margin_mm", "vessels_crossed", "tumor_incomplete"}
    assert 0 < out["flr_pct"] < 100 and _is_1dp(out["flr_pct"])
    assert isinstance(out["vessels_crossed"], int)
    assert execute(liver, "get_state", {})["plane"] == out["plane"]


def test_set_plane_relative(liver: Session) -> None:
    a = execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    b = execute(liver, "set_plane", {"offset_mm": 10})
    assert b["plane"]["d"] == pytest.approx(a["plane"]["d"] + 10)
    # Positive offset moves toward the resected side: less liver kept.
    assert b["flr_pct"] > a["flr_pct"] or b["flr_pct"] == a["flr_pct"]
    c = execute(liver, "set_plane", {"rotate_deg": {"axis": "z", "deg": 90}})
    assert c["plane"]["normal"] == pytest.approx([0.0, 1.0, 0.0], abs=1e-4)


def test_set_plane_errors(liver: Session) -> None:
    assert "error" in execute(liver, "set_plane", {})
    assert "error" in execute(liver, "set_plane", {"normal": [1, 0, 0]})
    assert "error" in execute(liver, "set_plane", {"normal": [0, 0, 0], "d": 1})
    assert "error" in execute(liver, "set_plane", {"offset_mm": 500})  # schema max 100


def test_tumor_through_plane_is_incomplete(liver: Session) -> None:
    tc = liver.case.grid.tumor_centroid()
    out = execute(liver, "set_plane", {"normal": [1, 0, 0], "d": float(tc[0])})
    assert out["tumor_incomplete"] is True
    assert out["margin_mm"] == 0.0


def test_measure(liver: Session) -> None:
    assert "error" in execute(liver, "measure", {"what": "flr"})  # no cut yet
    execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    for what, unit in [("flr", "%"), ("margin", "mm"), ("vessels_crossed", ""), ("tumor_volume", "mL")]:
        out = execute(liver, "measure", {"what": what})
        assert set(out) == {"what", "value", "unit", "method"}
        assert out["what"] == what and out["unit"] == unit and out["method"]
    assert execute(liver, "measure", {"what": "tumor_volume"})["value"] == pytest.approx(39.5, abs=0.05)
    d = execute(liver, "measure", {"what": "distance", "a": "tumor", "b": "hepatic_vessels"})
    assert d["unit"] == "mm" and d["value"] > 0
    assert execute(liver, "measure", {"what": "distance", "a": "plane", "b": "tumor"})["value"] >= 0
    assert "error" in execute(liver, "measure", {"what": "distance", "a": "tumor"})
    assert "error" in execute(liver, "measure", {"what": "distance", "a": "tumor", "b": "spleen"})
    assert "error" in execute(liver, "measure", {"what": "neck_length"})  # liver case


def test_measure_neck(aorta: Session) -> None:
    n = execute(aorta, "measure", {"what": "neck_length"})
    assert n["unit"] == "mm" and n["value"] >= 10
    assert execute(aorta, "measure", {"what": "neck_diameter"})["value"] > 10
    assert "error" in execute(aorta, "measure", {"what": "tumor_volume"})


def test_set_threshold(liver: Session) -> None:
    out = execute(liver, "set_threshold", {"name": "margin_min_mm", "value": 12})
    assert out == {"thresholds": {"margin_min_mm": 12.0, "flr_min_pct": 30.0}}
    assert "margin_min_mm" in liver.user_thresholds
    assert "error" in execute(liver, "set_threshold", {"name": "nope", "value": 1})


def test_optimize_plane(liver: Session) -> None:
    execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    out = execute(liver, "optimize_plane", {})
    assert set(out) == {"plane", "before", "after", "feasible", "reason_codes", "angle_deg", "offset_mm"}
    assert set(out["after"]) == {"flr_pct", "margin_mm", "vessels_crossed"}
    assert out["feasible"] is True
    assert out["after"]["margin_mm"] >= 10 and out["after"]["vessels_crossed"] == 0
    assert out["reason_codes"][-1] in ("local_search", "wide_search")
    # The plane moved, and the session now reports the optimized numbers.
    assert execute(liver, "get_state", {})["plane"] == out["plane"]
    assert execute(liver, "measure", {"what": "flr"})["value"] == out["after"]["flr_pct"]


def test_optimize_plane_bounded_and_thresholds(liver: Session) -> None:
    execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    out = execute(liver, "optimize_plane", {"margin_min_mm": 12, "max_rotate_deg": 5, "max_offset_mm": 5})
    assert out["angle_deg"] <= 5.0 + 1e-6 and out["offset_mm"] <= 5.0 + 1e-6
    assert "local_search" in out["reason_codes"]
    assert execute(liver, "get_state", {})["thresholds"]["margin_min_mm"] == 12.0


def test_optimize_plane_without_cut(liver: Session) -> None:
    out = execute(liver, "optimize_plane", {"avoid": ["hepatic_vessels"]})
    assert out["reason_codes"][:2] == ["no_cut", "wide_search"]
    assert "error" in execute(liver, "optimize_plane", {"avoid": ["spleen"]})


def test_cut_tools_need_the_liver_case(aorta: Session) -> None:
    assert "not a liver resection case" in execute(aorta, "optimize_plane", {})["error"]
    out = execute(aorta, "set_plane", {"normal": [1, 0, 0], "d": 0})
    assert set(out) == {"plane", "note"}
    assert "error" in execute(aorta, "measure", {"what": "flr"})
    assert "error" in execute(aorta, "resect", {})
    assert execute(aorta, "write_plan", {})["metrics"] is None


def test_resect(liver: Session) -> None:
    assert "error" in execute(liver, "resect", {})
    s = execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    out = execute(liver, "resect", {})
    assert set(out) == {"resected_ml", "remnant_flr_pct"}
    assert out["remnant_flr_pct"] == s["flr_pct"]
    assert out["resected_ml"] > 0
    assert liver.resected


def test_place_stent(aorta: Session) -> None:
    out = execute(aorta, "place_stent", {"device_id": "generic"})
    assert set(out) == {"device_id", "s0_mm", "length_mm", "diameter_mm", "oversize_pct", "rules", "rules_source", "seals"}
    assert out["rules_source"] == "default"
    assert out["seals"] is True
    assert [r["id"] for r in out["rules"]] == ["renal", "neck_length", "oversize", "angulation"]
    assert all(set(r) == {"id", "pass", "value", "limit", "unit"} for r in out["rules"])
    assert execute(aorta, "get_state", {})["stent"] == out

    high = execute(aorta, "place_stent", {"device_id": "gore_excluder", "s0_mm": 5})
    assert high["seals"] is False
    assert next(r for r in high["rules"] if r["id"] == "renal")["pass"] is False

    short = execute(aorta, "place_stent", {"device_id": "x", "s0_mm": 100, "length_mm": 40})
    assert short["length_mm"] == 40.0


def test_place_stent_wrong_case(liver: Session) -> None:
    assert "error" in execute(liver, "place_stent", {"device_id": "gore_excluder"})
    assert "error" in execute(liver, "optimize_stent", {"device_id": "gore_excluder"})
    assert "error" in execute(liver, "place_stent", {})  # device_id required


def test_optimize_stent(aorta: Session) -> None:
    execute(aorta, "place_stent", {"device_id": "d", "s0_mm": 110})
    out = execute(aorta, "optimize_stent", {"device_id": "d"})
    assert out["found"] is True and out["seals"] is True and "moved_mm" in out
    execute(aorta, "place_stent", {"device_id": "d", "s0_mm": 10})
    bad = execute(aorta, "optimize_stent", {"device_id": "d"})
    assert bad == {"found": False, "failing_rule": "renal"}
    fresh = Session.open("aorta")
    assert execute(fresh, "optimize_stent", {"device_id": "d"})["found"] is True


def test_show_and_window(liver: Session) -> None:
    out = execute(liver, "show", {"structure_ids": ["tumor", "hepatic_vessels"], "mode": "isolate"})
    assert out["ok"] is True and out["visible"] == ["tumor", "hepatic_vessels"]
    out = execute(liver, "show", {"structure_ids": ["tumor"], "mode": "hide"})
    assert out["visible"] == ["hepatic_vessels"]
    # Highlighting a hidden structure shows it.
    assert execute(liver, "show", {"structure_ids": ["tumor"], "mode": "highlight"})["visible"] == ["tumor", "hepatic_vessels"]
    assert "error" in execute(liver, "show", {"structure_ids": ["spleen"], "mode": "hide"})
    assert execute(liver, "window", {"preset": "bone"}) == {"ok": True, "preset": "bone"}
    assert "error" in execute(liver, "window", {"preset": "brain"})


def test_unavailable_tools(liver: Session) -> None:
    assert execute(liver, "segment_point", {"xyz_mm": [1, 2, 3]})["error"] == "unavailable"


def test_lookup_device_rules(liver: Session) -> None:
    card = execute(liver, "lookup_device_rules", {"device_name": "GORE EXCLUDER AAA Endoprosthesis"})
    assert card["device_id"] == "gore-excluder" and card["rules_source"] == "ifu:gore-excluder"
    assert card["rules"] == {"neck_length_min_mm": 15, "neck_diameter_mm": [19, 32], "neck_angulation_max_deg": 60}
    assert card["not_found"] == ["oversize_pct"]
    assert all(src["url"].startswith("https://") and src["quote"] for src in card["sources"])
    missing = execute(liver, "lookup_device_rules", {"device_name": "Nellix"})
    assert missing["error"] == "not_found" and missing["rules_source"] == "default"


def test_device_card_drives_stent_verdict(aorta: Session) -> None:
    # The aorta case's neck (18.6 mm) is under the Excluder's sourced 19 mm minimum.
    default = execute(aorta, "place_stent", {"device_id": "generic"})
    assert default["seals"] and default["rules_source"] == "default"
    assert [r["id"] for r in default["rules"]] == ["renal", "neck_length", "oversize", "angulation"]
    gore = execute(aorta, "place_stent", {"device_id": "Gore Excluder"})
    assert gore["rules_source"] == "ifu:gore-excluder" and not gore["seals"]
    by_id = {r["id"]: r for r in gore["rules"]}
    assert by_id["neck_length"]["limit"] == 15.0 and by_id["angulation"]["limit"] == 60.0
    assert by_id["neck_diameter"] == {"id": "neck_diameter", "pass": False, "value": 18.6, "limit": [19.0, 32.0], "unit": "mm"}
    assert aorta.stent.fail_reason == "Neck diameter 18.6 millimeters, below the device minimum of 19"


def test_write_plan(liver: Session) -> None:
    empty = execute(liver, "write_plan", {})
    assert empty["plane"] is None and empty["metrics"] is None
    execute(liver, "set_plane", {"normal": [1, 0, 0], "d": 340})
    plan = execute(liver, "write_plan", {})
    assert plan["case_id"] == "liver" and plan["case_kind"] == "liver"
    assert set(plan["metrics"]) >= {"flr_pct", "margin_mm", "vessels_crossed", "tumor_incomplete", "resected_ml"}
    assert plan["thresholds"] == {"margin_min_mm": 10.0, "flr_min_pct": 30.0}
