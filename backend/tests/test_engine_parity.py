"""The Python engine against the TS engine, on the inputs and outputs that
scripts/parity_dump.ts recorded in tests/fixtures/parity.json (`make parity`
regenerates it).

Tolerances: remnant/FLR 0.1 pp, margin 0.5 mm, vessels exact, optimizer plane
within 1 deg and 1 mm (or an equal score), stent rule verdicts exact.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from app.config import REPO
from app.engine.grid import load_case
from app.engine.metrics import Plane, angle_deg, evaluate_plane
from app.engine.optimize import Thresholds, optimize_around, optimize_plane, quality
from app.engine.stent import (
    Centerline,
    evaluate_stent,
    optimize_stent,
    ostia_on_centerline,
    place_stent,
    preferred_start,
    rules,
    size_at,
)

FIXTURE = json.loads((REPO / "tests" / "fixtures" / "parity.json").read_text())
CASES = FIXTURE["cases"]


def _plane(p: dict) -> Plane:
    return Plane(tuple(p["n"]), p["d"])


def _th(t: dict) -> Thresholds:
    return Thresholds(t["marginMin"], t["remnantMin"], t.get("vesselPenalty", "hard"), t.get("priority", "balanced"))


def _assert_metrics(got, want, ctx: str) -> None:
    assert abs(got.remnant_pct - want["remnantPct"]) <= 0.1, ctx
    assert abs(got.resected_ml - want["resectedMl"]) <= 0.5, ctx
    assert abs(got.margin_mm - want["marginMm"]) <= 0.5, ctx
    assert got.tumor_incomplete == want["tumorIncomplete"], ctx
    assert got.vessels_crossed == want["vesselsCrossed"], ctx
    assert got.vessel_id == want["vesselId"], ctx
    if want["nearestVesselMm"] is not None:
        assert abs(got.nearest_vessel_mm - want["nearestVesselMm"]) <= 0.01, ctx


@pytest.mark.parametrize("case_id", list(CASES))
def test_grid(case_id: str) -> None:
    want = CASES[case_id]["grid"]
    case = load_case(case_id)
    g = case.grid
    assert [g.nx, g.ny, g.nz] == want["shape"]
    assert case.factor == want["factor"]
    assert (g.organ_idx.size, g.tumor_idx.size, g.vessel_idx.size) == (want["organ"], want["tumor"], want["vessel"])
    box = g.organ_box
    assert [list(box[0]), list(box[1])] == [want["organBox"]["lo"], want["organBox"]["hi"]]
    c = case.coarse
    assert [c.nx, c.ny, c.nz] == want["coarseShape"]
    assert c.organ_idx.size == want["coarseOrgan"]
    np.testing.assert_allclose(g.organ_centroid(), want["organCentroid"], atol=1e-6)


@pytest.mark.parametrize("case_id", list(CASES))
def test_plane_metrics(case_id: str) -> None:
    case = load_case(case_id)
    for i, row in enumerate(CASES[case_id]["planes"]):
        got = evaluate_plane(case.grid, _plane(row["plane"]), case.names)
        _assert_metrics(got, row["metrics"], f"{case_id} plane {i}")


def _optimizer_rows():
    for case_id, c in CASES.items():
        for i, row in enumerate(c["optimizer"]):
            yield pytest.param(case_id, row, id=f"{case_id}-{i}-{row['mode']}")


@pytest.mark.parametrize(("case_id", "row"), list(_optimizer_rows()))
def test_optimizer(case_id: str, row: dict) -> None:
    case = load_case(case_id)
    th = _th(row["th"])
    start = _plane(row["start"]) if row["start"] else None
    if row["mode"] == "local":
        got = optimize_plane(case, start, th)
    else:
        got = optimize_around(case, start, th)
    want = row
    same_plane = angle_deg(got.plane.n, want["plane"]["n"]) <= 1.0 and abs(got.plane.d - want["plane"]["d"]) <= 1.0
    equal_score = math.isclose(quality(got, th), want["quality"], abs_tol=1e-6)
    assert same_plane or equal_score, (got.plane, want["plane"])
    assert got.candidates == want["candidates"]
    assert got.feasible == want["feasible"]
    assert got.violated == want["violated"]
    _assert_metrics(got.after, want["after"], "after")
    _assert_metrics(got.before, want["before"], "before")


@pytest.fixture(scope="module")
def aorta():
    case = load_case("aorta")
    cl = Centerline(case.centerlines["vessels"]["aorta"])
    return cl, ostia_on_centerline(cl, case.centerlines["renalOstia"])


def _assert_stent(got, want: dict) -> None:
    assert abs(got.s0 - want["s0"]) <= 1e-6
    assert abs(got.diameter_mm - want["diameterMm"]) <= 1e-6
    assert abs(got.neck_mm - want["neckMm"]) <= 1e-6
    assert abs(got.oversize_pct - want["oversizePct"]) <= 1e-6
    assert abs(got.angulation_deg - want["angulationDeg"]) <= 1e-6
    assert got.seals == want["seals"]
    assert got.fail_reason == want["failReason"]
    # Every rule's pass/fail is consistent with the single verdict.
    assert all(r["pass"] for r in rules(got)) == want["seals"]


def test_stent(aorta) -> None:
    cl, ostia = aorta
    want = CASES["aorta"]["stent"]
    assert abs(cl.length - want["length"]) <= 1e-6
    assert [(o.s, o.side) for o in ostia] == [(o["s"], o["side"]) for o in want["ostia"]]
    for w in want["seats"]:
        _assert_stent(evaluate_stent(cl, ostia, w["s0"], size_at(cl, w["s0"])), w)
    for w in want["fixedDiameter"]:
        _assert_stent(evaluate_stent(cl, ostia, w["s0"], 30), w)
    _assert_stent(place_stent(cl, ostia, preferred_start(ostia, 30)), want["placed"])
    for w in want["optimized"]:
        cur = evaluate_stent(cl, ostia, w["from"], size_at(cl, w["from"]))
        st, moved, blocker = optimize_stent(cl, ostia, cur)
        assert blocker == w["blocker"]
        assert moved == w["movedMm"]
        if w["stent"] is None:
            assert st is None
        else:
            _assert_stent(st, w["stent"])
