"""The agent's tools, executed against the Python engine.

`execute(session, name, args) -> dict` runs one tool from shared/tools.json
and returns a JSON-safe dict. It never raises: bad arguments, unknown
structures and tools that do not apply to the case come back as
`{"error": "..."}`. Result shapes are documented in docs/TOOLS.md and are
mirrored by the browser's TS executor; keep the two in step.

Numbers are rounded the way the HUD shows them: one decimal for %, mm, mL and
degrees (Math.round(x * 10) / 10, halves up), four for unit normals, integers
as integers. The session keeps full precision.

Error strings match the TS executor's too: `make tool-parity` replays one
script through both (tests/fixtures/tool_script.json) and requires identical
JSON.
"""

from __future__ import annotations

import math
from typing import Any, Callable

import numpy as np

from ..tools import validate_call
from . import device_rules
from .grid import Case, edt3d
from .metrics import Metrics, Plane, evaluate_plane, normalize, project
from .optimize import CONE_DEG, OFFSET_MM, Thresholds, optimize, violations
from .session import Session
from .stent import (
    FALLBACK_S0,
    NECK_WINDOW_MM,
    Limits,
    STENT_LENGTH_MM,
    StentState,
    evaluate_stent,
    max_start,
    optimize_stent,
    place_stent,
    preferred_start,
    rule_of_reason,
    rules,
    size_at,
)

THRESHOLD_FIELDS = {"margin_min_mm": "margin_min", "flr_min_pct": "remnant_min"}
PLANE_ID = "plane"
# measure distance gives up beyond this gap (smartMeasure.ts reach).
REACH_MM = 120.0
NO_CUT = "no cut placed yet; use set_plane or optimize_plane first"


def r1(x: float | None) -> float | None:
    """One decimal, halves up (Math.round(x * 10) / 10), so both executors agree."""
    if x is None or not math.isfinite(x):
        return None
    return math.floor(x * 10 + 0.5) / 10


def r4(x: float) -> float:
    return math.floor(x * 10000 + 0.5) / 10000


def plane_json(p: Plane) -> dict[str, Any]:
    return {"normal": [r4(v) for v in p.n], "d": r1(p.d)}


def metrics_json(m: Metrics) -> dict[str, Any]:
    return {"flr_pct": r1(m.remnant_pct), "margin_mm": r1(m.margin_mm), "vessels_crossed": int(m.vessels_crossed)}


def thresholds_json(th: Thresholds) -> dict[str, float]:
    return {"margin_min_mm": r1(th.margin_min), "flr_min_pct": r1(th.remnant_min)}


def limits_for(device_id: str | None) -> Limits:
    """The device's rule card limits (data/device_rules/), else the default simplified EVAR rules."""
    return device_rules.limits_of(device_rules.find(device_id))


def stent_json(device_id: str | None, st: StentState) -> dict[str, Any]:
    lim = limits_for(device_id)
    return {
        "device_id": device_id,
        "s0_mm": r1(st.s0),
        "length_mm": r1(st.length_mm),
        "diameter_mm": r1(st.diameter_mm),
        "oversize_pct": r1(st.oversize_pct),
        "rules": [
            {**r, "value": r1(r["value"]), "limit": [r1(v) for v in r["limit"]] if isinstance(r["limit"], list) else r1(r["limit"])}
            for r in rules(st, lim)
        ],
        "rules_source": lim.source,
        "seals": st.seals,
    }


class ToolError(Exception):
    pass


def _metrics(s: Session) -> Metrics:
    return evaluate_plane(s.case.grid, s.plane, s.case.names)


def _need_cut(s: Session) -> None:
    if not s.plane_on:
        raise ToolError(NO_CUT)


def _not_liver(s: Session) -> str:
    return f"the {s.case.kind} case is not a liver resection case; cut metrics need the liver case"


def _need_liver(s: Session) -> None:
    # DECISION: cut metrics belong to the liver case, as on the HUD; the aorta
    # case's liver mask is context, not a resection target.
    if s.case.kind != "liver":
        raise ToolError(_not_liver(s))


def _need_tumor(s: Session) -> None:
    if s.case.grid.tumor_idx.size == 0:
        raise ToolError(f'case "{s.case.id}" has no tumour')


def _need_aorta(s: Session) -> None:
    if s.case.kind != "aorta":
        raise ToolError(f'stent grafts are for the aorta case; "{s.case.id}" is a {s.case.kind} case')
    if s.centerline is None:
        raise ToolError("no aorta centerline in this case")


def _check_ids(s: Session, ids: list[str], allow_plane: bool = False) -> None:
    valid = list(s.case.keys) + ([PLANE_ID] if allow_plane else [])
    bad = [i for i in ids if i not in valid]
    if bad:
        quoted = ", ".join(f'"{b}"' for b in bad)
        raise ToolError(f"unknown structure {quoted}; valid ids: {', '.join(sorted(valid))}")


# ------------------------------------------------------------------- tools


def get_state(s: Session, _: dict[str, Any]) -> dict[str, Any]:
    return {
        "case_id": s.case.id,
        "case_kind": s.case.kind,
        "mode": s.mode,
        "plane": plane_json(s.plane) if s.plane_on else None,
        "stent": stent_json(s.device_id, s.stent) if s.stent else None,
        "thresholds": thresholds_json(s.thresholds),
        "visible": [k for k in s.case.keys if s.visible.get(k)],
    }


def _plane_distance(s: Session, other: str) -> float:
    """Min |n.x - d| over the structure's planning-grid voxel centres; 0 if the plane cuts it."""
    g = s.case.grid
    idx = np.flatnonzero(g.labels == s.case.label_by_key[other]["id"])
    if idx.size == 0:
        raise ToolError(f'"{other}" is not on the planning grid')
    sd = project(g.coords(idx), s.plane.n) - s.plane.d
    return 0.0 if (sd.min() <= 0 <= sd.max()) else float(np.abs(sd).min())


def structure_distance(case: Case, a_id: int, b_id: int, reach_mm: float = REACH_MM) -> float | None:
    """Closest wall-to-wall gap between two labels (smartMeasure.ts structureDistance).

    Exact EDT from the smaller structure over its bounding box grown by
    `reach_mm`, on the full-resolution labels; the min over the other
    structure's voxels is a centre-to-centre distance, so one mean voxel size
    comes off for the two half-voxel walls. None beyond `reach_mm`.
    """
    m = case.meta
    nx, ny, nz = m["shape"]
    sp = m["spacing"]
    lab = case.labels_full.reshape(nz, ny, nx)
    a, b = lab == a_id, lab == b_id
    if a.sum() > b.sum():
        a, b = b, a
    ka, ja, ia = np.nonzero(a)
    lo = [int(ia.min()), int(ja.min()), int(ka.min())]
    hi = [int(ia.max()), int(ja.max()), int(ka.max())]
    for k, n in enumerate((nx, ny, nz)):
        r = math.ceil(reach_mm / sp[k])
        lo[k], hi[k] = max(0, lo[k] - r), min(n - 1, hi[k] + r)
    box = (slice(lo[2], hi[2] + 1), slice(lo[1], hi[1] + 1), slice(lo[0], hi[0] + 1))
    sub_a, sub_b = a[box], b[box]
    if not sub_b.any():
        return None
    shape = (sub_a.shape[2], sub_a.shape[1], sub_a.shape[0])
    dist = edt3d(sub_a.reshape(-1), shape, tuple(sp))
    best = float(dist[sub_b.reshape(-1)].min())
    if best > reach_mm:
        return None
    return max(0.0, best - (sp[0] + sp[1] + sp[2]) / 3)


def _distance(s: Session, a: str, b: str) -> tuple[float, str]:
    if PLANE_ID in (a, b):
        method = "min |n.x - d| over the structure voxel centres (0 if the plane cuts it)"
        if a == b:
            return 0.0, method
        _need_cut(s)
        return _plane_distance(s, b if a == PLANE_ID else a), method
    ia, ib = s.case.label_by_key[a]["id"], s.case.label_by_key[b]["id"]
    full = s.case.labels_full
    if not (full == ia).any() or not (full == ib).any():
        raise ToolError(f'"{a}" or "{b}" has no voxels in this case')
    cache = s.case.__dict__.setdefault("_distance", {})
    if (ia, ib) not in cache:
        cache[(ia, ib)] = structure_distance(s.case, ia, ib)
    v = cache[(ia, ib)]
    if v is None:
        raise ToolError(f'"{a}" and "{b}" are more than {REACH_MM:g} mm apart')
    # The app frames the two structures, which shows them.
    s.visible[a] = s.visible[b] = True
    return v, "closest wall-to-wall gap: min voxel-centre distance (exact EDT, full-resolution labels) minus the mean voxel size"


def _neck(s: Session) -> StentState:
    _need_aorta(s)
    if s.stent is not None:
        return s.stent
    return place_stent(s.centerline, s.ostia, preferred_start(s.ostia, FALLBACK_S0), lim=limits_for(s.device_id))


def measure(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    what = a["what"]
    if what == "flr":
        _need_liver(s)
        _need_cut(s)
        return {"what": what, "value": r1(_metrics(s).remnant_pct), "unit": "%",
                "method": "kept organ voxels / organ voxels x 100 (organ = liver + tumour)"}
    if what == "margin":
        _need_liver(s)
        _need_tumor(s)
        _need_cut(s)
        return {"what": what, "value": r1(_metrics(s).margin_mm), "unit": "mm",
                "method": "min tumour distance (EDT) over kept organ voxels within one voxel diagonal of the plane; 0 if tumour is kept"}
    if what == "vessels_crossed":
        _need_liver(s)
        _need_cut(s)
        return {"what": what, "value": int(_metrics(s).vessels_crossed), "unit": "",
                "method": "6-connected vessel components within one voxel diagonal of the plane, in the organ box, >= 120 mm^3"}
    if what == "tumor_volume":
        _need_tumor(s)
        tid = s.case.grid.organ_ids[1]
        sp = s.case.meta["spacing"]
        ml = int((s.case.labels_full == tid).sum()) * sp[0] * sp[1] * sp[2] / 1000
        return {"what": what, "value": r1(ml), "unit": "mL", "method": "tumour voxels x voxel volume (full-resolution labels)"}
    if what == "neck_length":
        st = _neck(s)
        return {"what": what, "value": r1(st.neck_mm), "unit": "mm",
                "method": "length distal to the stent's proximal end where lumen diameter stays within 10% of the 15 mm neck mean"}
    if what == "neck_diameter":
        st = _neck(s)
        return {"what": what, "value": r1(s.centerline.mean_diameter(st.s0, st.s0 + NECK_WINDOW_MM)), "unit": "mm",
                "method": "mean lumen diameter over the first 15 mm below the stent's proximal end, sampled every 1 mm"}
    if what == "distance":
        if not a.get("a") or not a.get("b"):
            raise ToolError("distance needs a and b")
        _check_ids(s, [a["a"], a["b"]], allow_plane=True)
        v, method = _distance(s, a["a"], a["b"])
        return {"what": what, "value": r1(v), "unit": "mm", "method": method}
    raise ToolError(f'unknown measure "{what}"')


_AXES = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}


def _rotate(v: tuple[float, float, float], k: tuple[float, float, float], rad: float) -> tuple[float, float, float]:
    """Rodrigues: v turned by rad about unit k (main.ts rotateAbout)."""
    c, sn = math.cos(rad), math.sin(rad)
    kv = (k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0])
    kd = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c)
    return tuple(v[i] * c + kv[i] * sn + k[i] * kd for i in range(3))  # type: ignore[return-value]


def set_plane(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    has_abs = "normal" in a or "d" in a
    if has_abs and not ("normal" in a and "d" in a):
        raise ToolError("give normal and d together")
    if not has_abs and "rotate_deg" not in a and "offset_mm" not in a:
        raise ToolError("give normal and d, or rotate_deg and/or offset_mm")
    n, d = s.plane.n, s.plane.d
    if has_abs:
        if math.sqrt(sum(float(x) ** 2 for x in a["normal"])) < 1e-6:
            raise ToolError("normal must be non-zero")
        n, d = normalize(a["normal"]), float(a["d"])
    if "rotate_deg" in a:
        # Turns pivot on the point of the cut nearest the tumour (else the organ) centre.
        g = s.case.grid
        c = g.tumor_centroid()
        if c is None:
            c = g.organ_centroid()
        if c is None:
            c = np.zeros(3)
        off = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - d
        pivot = (c[0] - n[0] * off, c[1] - n[1] * off, c[2] - n[2] * off)
        rot = a["rotate_deg"]
        n = normalize(_rotate(n, _AXES[rot["axis"]], math.radians(float(rot["deg"]))))
        d = n[0] * pivot[0] + n[1] * pivot[1] + n[2] * pivot[2]
    if "offset_mm" in a:
        d += float(a["offset_mm"])
    s.set_plane(n, d)
    if s.case.kind != "liver":
        return {"plane": plane_json(s.plane), "note": _not_liver(s)}
    m = _metrics(s)
    return {"plane": plane_json(s.plane), **metrics_json(m), "tumor_incomplete": bool(m.tumor_incomplete)}


REASON_CODES = {"tumor": "tumor_incomplete", "margin": "margin_below_min", "remnant": "flr_below_min", "vessels": "vessels_crossed"}


def optimize_plane(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    _need_liver(s)
    _need_tumor(s)
    avoid = a.get("avoid") or []
    _check_ids(s, avoid)
    for key, attr in THRESHOLD_FIELDS.items():
        if key in a:
            # DECISION: targets given to optimize change the session thresholds
            # for good, as a spoken "optimize for a 12 mm margin" does in main.ts.
            setattr(s.thresholds, attr, float(a[key]))
            s.user_thresholds.add(key)
    th = Thresholds(s.thresholds.margin_min, s.thresholds.remnant_min, s.thresholds.vessel_penalty,
                    # DECISION: "avoid" maps onto the app's "vessels" priority
                    # (spare every vessel, even below the margin target); the
                    # engine has no per-structure penalty.
                    "vessels" if avoid else "balanced")
    bounded = "max_rotate_deg" in a or "max_offset_mm" in a
    cone = float(a.get("max_rotate_deg", CONE_DEG))
    offs = int(math.floor(float(a.get("max_offset_mm", OFFSET_MM))))
    start = Plane(s.plane.n, s.plane.d) if s.plane_on else None
    # DECISION: explicit bounds keep the search local (no wide fallback),
    # unless there is no usable cut to be local to.
    res, search = optimize(s.case, start, th, cone_deg=cone, offset_mm=offs, allow_wide=not bounded)
    if res is None:
        raise ToolError("optimizer found no plane")
    s.set_plane(res.plane.n, res.plane.d)
    codes = [REASON_CODES[v] for v in res.violated] if start is not None else ["no_cut"]
    codes.append("wide_search" if search == "wide" else "local_search")
    crossed_ids = {c["id"] for c in res.after.vessel_cuts}
    avoid_ids = {s.case.label_by_key[k]["id"] for k in avoid}
    if crossed_ids & avoid_ids:
        codes.append("avoid_crossed")
    return {
        "plane": plane_json(res.plane),
        "before": metrics_json(res.before),
        "after": metrics_json(res.after),
        "feasible": bool(res.feasible),
        "reason_codes": codes,
        "angle_deg": r1(res.angle_deg),
        "offset_mm": r1(res.offset_mm),
    }


def place_stent_tool(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    _need_aorta(s)
    cl, ostia = s.centerline, s.ostia
    # Clamped to the centerline like StentSession.placeAt.
    length = min(max(float(a.get("length_mm", STENT_LENGTH_MM)), 20.0), cl.length)
    # DECISION: a device with a rule card (data/device_rules/) is checked and
    # sized against it; any other device gets the default simplified EVAR rules.
    lim = limits_for(a["device_id"])
    if "s0_mm" in a:
        s0 = min(max(float(a["s0_mm"]), 0.0), max_start(cl, length))
        st = evaluate_stent(cl, ostia, s0, size_at(cl, s0, lim), length, lim)
    else:
        st = place_stent(cl, ostia, preferred_start(ostia, FALLBACK_S0), length, lim)
    s.stent, s.device_id = st, a["device_id"]
    return stent_json(s.device_id, st)


def optimize_stent_tool(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    _need_aorta(s)
    cl, ostia = s.centerline, s.ostia
    cur = s.stent
    lim = limits_for(a["device_id"])
    if cur is None:
        # DECISION: with no device placed, start from where a fresh one would
        # seat (just below the lowest renal), sized there.
        s0 = min(max(preferred_start(ostia, FALLBACK_S0), 0.0), max_start(cl))
        cur = evaluate_stent(cl, ostia, s0, size_at(cl, s0, lim), lim=lim)
    st, moved, blocker = optimize_stent(cl, ostia, cur, lim=lim)
    s.device_id = a["device_id"]
    if st is None:
        return {"found": False, "failing_rule": rule_of_reason(blocker)}
    s.stent = st
    return {"found": True, "moved_mm": r1(moved), **stent_json(s.device_id, st)}


def set_threshold(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    setattr(s.thresholds, THRESHOLD_FIELDS[a["name"]], float(a["value"]))
    s.user_thresholds.add(a["name"])
    return {"thresholds": thresholds_json(s.thresholds)}


def show(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    ids, mode = a["structure_ids"], a["mode"]
    _check_ids(s, ids)
    if mode == "highlight":
        # Highlighting shows the structure too, as the app's spoken "show" does.
        s.highlight = list(ids)
        for k in ids:
            s.visible[k] = True
    elif mode == "isolate":
        s.visible = {k: k in ids for k in s.case.keys}
    else:
        for k in ids:
            s.visible[k] = False
    return {"ok": True, "structure_ids": list(ids), "mode": mode, "visible": [k for k in s.case.keys if s.visible.get(k)]}


def window(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    s.preset = a["preset"]
    return {"ok": True, "preset": s.preset}


def resect(s: Session, _: dict[str, Any]) -> dict[str, Any]:
    _need_liver(s)
    _need_cut(s)
    m = _metrics(s)
    s.resected = True
    return {"resected_ml": r1(m.resected_ml), "remnant_flr_pct": r1(m.remnant_pct)}


def segment_point(s: Session, _: dict[str, Any]) -> dict[str, Any]:
    # The offline engine (eval, data generation) has no VISTA-3D endpoint; the app calls vista3d-point.
    return {"error": "unavailable", "reason": "segmentation service not configured"}


def lookup_device_rules(s: Session, a: dict[str, Any]) -> dict[str, Any]:
    # Cached cards only: the live Tavily lookup is the backend's /api/rules.
    card = device_rules.find(a["device_name"])
    if card is None:
        return {"error": "not_found", "reason": f'no rule card for "{a["device_name"]}"; default simplified EVAR rules apply',
                "rules_source": "default"}
    return device_rules.card_json(card)


def write_plan(s: Session, _: dict[str, Any]) -> dict[str, Any]:
    plan: dict[str, Any] = {
        "case_id": s.case.id,
        "case_kind": s.case.kind,
        "plane": plane_json(s.plane) if s.plane_on else None,
        "metrics": None,
        "stent": stent_json(s.device_id, s.stent) if s.stent else None,
        "thresholds": thresholds_json(s.thresholds),
        "resected": s.resected,
    }
    if s.plane_on and s.case.kind == "liver":
        m = _metrics(s)
        th = s.thresholds
        plan["metrics"] = {**metrics_json(m), "tumor_incomplete": bool(m.tumor_incomplete), "resected_ml": r1(m.resected_ml),
                           "meets_targets": not violations(m, th) if s.case.grid.tumor_idx.size else None}
    return plan


TOOLS: dict[str, Callable[[Session, dict[str, Any]], dict[str, Any]]] = {
    "get_state": get_state,
    "measure": measure,
    "set_plane": set_plane,
    "optimize_plane": optimize_plane,
    "place_stent": place_stent_tool,
    "optimize_stent": optimize_stent_tool,
    "set_threshold": set_threshold,
    "show": show,
    "window": window,
    "resect": resect,
    "segment_point": segment_point,
    "lookup_device_rules": lookup_device_rules,
    "write_plan": write_plan,
}


def execute(session: Session, name: str, args: dict[str, Any] | str | None = None) -> dict[str, Any]:
    """Run one tool call. Arguments are schema-validated first; nothing raises."""
    fn = TOOLS.get(name)
    if fn is None:
        return {"error": f'unknown tool "{name}"'}
    parsed, errors = validate_call(name, args)
    if errors or parsed is None:
        return {"error": "; ".join(errors) or "invalid arguments"}
    try:
        return fn(session, parsed)
    except ToolError as e:
        return {"error": str(e)}
    except Exception as e:  # noqa: BLE001 - the agent loop must never die on a tool
        return {"error": f"{name} failed: {type(e).__name__}: {e}"}
