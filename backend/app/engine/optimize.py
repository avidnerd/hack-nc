"""The plane optimizer, ported from src/planning/optimize.ts.

Local search (`optimize_plane`): 121 normals on a Fibonacci cap of +-20 deg
around the surgeon's normal, times offsets d0 +-15 mm in 1 mm steps, pivoting
about the point of the plane nearest the organ centre (3751 candidates).
Wide search (`optimize_around`): 145 normals within 75 deg of "out of the
organ through the tumour", at 15 offsets that put the plane from
(margin target - 2) to (margin target + 12) mm off the tumour's near face.

Each candidate is ranked with:

    score = remnant %
            - 10000 [tumour kept]
            - w.margin [margin < target] - w.shortfall * max(0, target - margin)
            - w.remnant [remnant < target]
            - w.vessel * vessels crossed
            - w.stay * angle to start (deg) - w.stay * |d - d_start| (mm)

with remnant on the coarse grid, margin as the exact plane-to-tumour distance
(min n.t - d over full-resolution tumour voxels), and vessels counted on the
planning grid. The top 24 and the best 16 near misses (up to 4 mm short of the
margin target) are re-scored on the planning grid with the real cut-surface
margin, together with the surgeon's own plane, and the best wins.

Vectorised per direction: remnant counts come from one sorted projection and
`searchsorted`, vessel counts from one sparse connected-components call.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .grid import Case, Grid
from .metrics import Metrics, Plane, angle_deg, evaluate_plane, normalize, project, vessel_crossings_along

CONE_DEG = 20.0
DIRECTIONS = 121
OFFSET_MM = 15
RESCORE = 24
NEAR_MISSES = 16
MARGIN_SLACK_MM = 4.0
WIDE_CONE_DEG = 75.0
WIDE_DIRECTIONS = 145
WIDE_BELOW = 2
WIDE_ABOVE = 12


@dataclass
class Thresholds:
    margin_min: float = 10.0
    remnant_min: float = 30.0
    vessel_penalty: str = "hard"
    priority: str = "balanced"


@dataclass
class OptimizeResult:
    plane: Plane
    before: Metrics
    after: Metrics
    angle_deg: float
    offset_mm: float
    feasible: bool
    violated: list[str]
    candidates: int
    ms: float
    score: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)


def weights(th: Thresholds) -> dict[str, float]:
    p = th.priority
    return {
        "margin": 1000.0,
        "shortfall": 20.0 if p == "vessels" else 0.0,
        "remnant": 5000.0 if p == "vessels" else 1000.0,
        "vessel": 1500.0 if p == "vessels" else (200.0 if th.vessel_penalty == "hard" else 20.0),
        "stay": 0.05 if p == "remnant" else 0.3,
    }


def score(m: Metrics, n: Any, d: float, n0: Any, d0: float, th: Thresholds) -> float:
    w = weights(th)
    return (
        m.remnant_pct
        - 10000 * (1 if m.tumor_incomplete else 0)
        - w["margin"] * (1 if m.margin_mm < th.margin_min else 0)
        - w["shortfall"] * max(0.0, th.margin_min - m.margin_mm)
        - w["remnant"] * (1 if m.remnant_pct < th.remnant_min else 0)
        - w["vessel"] * m.vessels_crossed
        - w["stay"] * angle_deg(n, n0)
        - w["stay"] * abs(d - d0)
    )


def _score_vec(remnant: np.ndarray, margin: np.ndarray, incomplete: np.ndarray, crossed: np.ndarray,
               angle: float, dd: np.ndarray, th: Thresholds) -> np.ndarray:
    """`score` for a batch of candidates sharing one normal, same term order."""
    w = weights(th)
    return (
        remnant
        - 10000 * incomplete.astype(np.float64)
        - w["margin"] * (margin < th.margin_min).astype(np.float64)
        - w["shortfall"] * np.maximum(0.0, th.margin_min - margin)
        - w["remnant"] * (remnant < th.remnant_min).astype(np.float64)
        - w["vessel"] * crossed
        - w["stay"] * angle
        - w["stay"] * np.abs(dd)
    )


def fibonacci_cap(axis: Any, deg: float, count: int) -> list[tuple[float, float, float]]:
    """`count` unit vectors spread evenly over a cap of half-angle `deg` (i = 0 is the axis)."""
    a = normalize(axis)
    seed = (1.0, 0.0, 0.0) if abs(a[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = normalize(np.cross(a, seed))
    v = tuple(float(x) for x in np.cross(a, u))
    cos_max = math.cos(deg * math.pi / 180)
    golden = math.pi * (3 - math.sqrt(5))
    out = []
    for i in range(count):
        z = 1.0 if count == 1 else 1 - (i / (count - 1)) * (1 - cos_max)
        r = math.sqrt(max(0.0, 1 - z * z))
        phi = i * golden
        x = r * math.cos(phi)
        y = r * math.sin(phi)
        out.append(normalize([u[0] * x + v[0] * y + a[0] * z, u[1] * x + v[1] * y + a[1] * z, u[2] * x + v[2] * y + a[2] * z]))
    return out


def violations(m: Metrics, th: Thresholds) -> list[str]:
    out = []
    if m.tumor_incomplete:
        out.append("tumor")
    elif m.margin_mm < th.margin_min:
        out.append("margin")
    if m.remnant_pct < th.remnant_min:
        out.append("remnant")
    if m.vessels_crossed > 0:
        out.append("vessels")
    return out


def _organ_centre(g: Grid) -> np.ndarray:
    if g.organ_idx.size == 0:
        return np.zeros(3)
    return g.organ_xyz.sum(axis=0) / g.organ_idx.size


def _sorted_organ_t(coarse: Grid, n: Any) -> np.ndarray:
    return np.sort(project(coarse.organ_xyz, n))


def _remnant_at(sorted_t: np.ndarray, ds: np.ndarray) -> np.ndarray:
    # Kept means n.x - d <= 0, i.e. n.x <= d: a right-sided search counts them.
    total = sorted_t.size
    if total == 0:
        return np.zeros(ds.size)
    return 100 * np.searchsorted(sorted_t, ds, side="right") / total


def _finalists_eval(case: Case, finalists: list[tuple[Any, float, float]], n0: Any | None, th: Thresholds):
    """Re-score finalists on the planning grid; strict > keeps the earliest on a tie."""
    best = None
    for n, d, base in finalists:
        m = evaluate_plane(case.grid, Plane(n, d), case.names)
        s = score(m, n, d, n0 if n0 is not None else n, base if n0 is not None else d, th)
        if best is None or s > best[2]:
            best = (n, d, s, m)
    return best


def optimize_plane(case: Case, start: Plane, th: Thresholds, directions: int = DIRECTIONS,
                   cone_deg: float = CONE_DEG, offset_mm: int = OFFSET_MM) -> OptimizeResult:
    """Local search around `start` (optimizePlane with the fine grid as judge)."""
    t0 = time.perf_counter()
    fine, coarse = case.grid, case.coarse
    n0 = normalize(start.n)
    d0 = float(start.d)
    before = evaluate_plane(fine, Plane(n0, d0), case.names)

    # Rotations pivot about the point of the plane nearest the coarse organ centre.
    c = _organ_centre(coarse)
    s = n0[0] * c[0] + n0[1] * c[1] + n0[2] * c[2] - d0
    anchor = (c[0] - n0[0] * s, c[1] - n0[1] * s, c[2] - n0[2] * s)

    def base_for(n: Any) -> float:
        return n[0] * anchor[0] + n[1] * anchor[1] + n[2] * anchor[2]

    tumor = fine.tumor_xyz
    exact = tumor.shape[0] > 0
    w = weights(th)
    ks = np.arange(-offset_mm, offset_mm + 1, dtype=np.float64)
    ranked_s, ranked_c, near_s, near_c = [], [], [], []
    caps = fibonacci_cap(n0, cone_deg, directions)
    for di, n in enumerate(caps):
        base = base_for(n)
        ds = base + ks
        crossings = vessel_crossings_along(fine, n, ds)
        remnant = _remnant_at(_sorted_organ_t(coarse, n), ds)
        if exact:
            tmin = float(project(tumor, n).min())
            margin = np.maximum(0.0, tmin - ds)
            incomplete = tmin - ds <= 0
        else:
            # No tumour: the coarse margin is +inf, which evaluatePlane reports as 0.
            margin = np.zeros(ds.size)
            incomplete = np.zeros(ds.size, dtype=bool)
        sc = _score_vec(remnant, margin, incomplete, crossings, angle_deg(n, n0), ds - base, th)
        ranked_s.append(sc)
        ranked_c.extend((di, j) for j in range(ds.size))
        if exact:
            nm = ~incomplete & (margin < th.margin_min) & (margin >= th.margin_min - MARGIN_SLACK_MM)
            for j in np.flatnonzero(nm):
                near_s.append(sc[j] + w["margin"])
                near_c.append((di, int(j)))
    all_s = np.concatenate(ranked_s)
    order = np.argsort(-all_s, kind="stable")
    near_order = np.argsort(-np.asarray(near_s), kind="stable") if near_s else np.array([], dtype=int)

    def cand(di_j: tuple[int, int]) -> tuple[Any, float, float]:
        di, j = di_j
        n = caps[di]
        base = base_for(n)
        return (n, base + ks[j], base)

    # The surgeon's own plane is always a finalist, so the answer never scores worse than it.
    finalists = [(n0, d0, base_for(n0))]
    finalists += [cand(ranked_c[i]) for i in order[:RESCORE]]
    finalists += [cand(near_c[i]) for i in near_order[:NEAR_MISSES]]
    bn, bd, bs, bm = _finalists_eval(case, finalists, n0, th)
    return OptimizeResult(
        plane=Plane(bn, bd), before=before, after=bm,
        angle_deg=angle_deg(bn, n0), offset_mm=abs(bd - base_for(bn)),
        feasible=not violations(bm, th), violated=violations(before, th),
        candidates=int(all_s.size), ms=(time.perf_counter() - t0) * 1000, score=bs,
    )


def optimize_around(case: Case, start: Plane | None, th: Thresholds) -> OptimizeResult | None:
    """Wide search: the best cut anywhere around the tumour, on quality alone (optimizeAround)."""
    t0 = time.perf_counter()
    fine, coarse = case.grid, case.coarse
    tumor = fine.tumor_xyz
    if tumor.shape[0] == 0:
        return None
    tc = tumor.sum(axis=0) / tumor.shape[0]
    axis = normalize(tc - _organ_centre(coarse))
    w = weights(th)
    margins = np.arange(th.margin_min - WIDE_BELOW, th.margin_min + WIDE_ABOVE + 1e-9, 1.0)
    ranked_s, ranked_c, near_s, near_c = [], [], [], []
    caps = fibonacci_cap(axis, WIDE_CONE_DEG, WIDE_DIRECTIONS)
    ds_by_dir = []
    for di, n in enumerate(caps):
        tmin = float(project(tumor, n).min())
        ds = tmin - np.maximum(0.5, margins)
        ds_by_dir.append(ds)
        crossings = vessel_crossings_along(fine, n, ds)
        remnant = _remnant_at(_sorted_organ_t(coarse, n), ds)
        margin = tmin - ds
        sc = _score_vec(remnant, margin, np.zeros(ds.size, dtype=bool), crossings, 0.0, np.zeros(ds.size), th)
        ranked_s.append(sc)
        ranked_c.extend((di, j) for j in range(ds.size))
        nm = (margin < th.margin_min) & (margin >= th.margin_min - MARGIN_SLACK_MM)
        for j in np.flatnonzero(nm):
            near_s.append(sc[j] + w["margin"])
            near_c.append((di, int(j)))
    all_s = np.concatenate(ranked_s)
    order = np.argsort(-all_s, kind="stable")
    near_order = np.argsort(-np.asarray(near_s), kind="stable") if near_s else np.array([], dtype=int)

    def cand(di_j: tuple[int, int]) -> tuple[Any, float, float]:
        di, j = di_j
        d = float(ds_by_dir[di][j])
        return (caps[di], d, d)

    finalists = [cand(ranked_c[i]) for i in order[:RESCORE]] + [cand(near_c[i]) for i in near_order[:NEAR_MISSES]]
    if start is not None:
        sn = normalize(start.n)
        finalists.append((sn, float(start.d), float(start.d)))
    bn, bd, bs, bm = _finalists_eval(case, finalists, None, th)
    before = evaluate_plane(fine, Plane(normalize(start.n), start.d), case.names) if start is not None else bm
    n0 = normalize(start.n) if start is not None else bn
    return OptimizeResult(
        plane=Plane(bn, bd), before=before, after=bm,
        angle_deg=angle_deg(bn, n0), offset_mm=abs(bd - start.d) if start is not None else 0.0,
        feasible=not violations(bm, th), violated=violations(before, th),
        candidates=int(all_s.size), ms=(time.perf_counter() - t0) * 1000, score=bs,
    )


def quality(r: OptimizeResult, th: Thresholds) -> float:
    """A result's score with the stay-near-the-start terms dropped (main.ts)."""
    return score(r.after, r.plane.n, r.plane.d, r.plane.n, r.plane.d, th)


def through_organ(m: Metrics) -> bool:
    """True when a cut actually divides the organ (main.ts throughOrgan)."""
    return 2 < m.remnant_pct < 99.5


def optimize(case: Case, start: Plane | None, th: Thresholds, *, cone_deg: float = CONE_DEG,
             offset_mm: int = OFFSET_MM, allow_wide: bool = True) -> tuple[OptimizeResult | None, str]:
    """The app's "optimize" (main.ts optimizePlan): local first, wide when that fails.

    A cut through the organ is refined where it is; if nothing near it is
    feasible, the wide search runs and wins when its quality is better by more
    than 0.5. No cut, or one that misses the organ, goes straight to the wide
    search. Returns (result, "local" | "wide").
    """
    usable = start is not None and through_organ(evaluate_plane(case.grid, Plane(normalize(start.n), start.d), case.names))
    if not usable:
        return optimize_around(case, start, th), "wide"
    res = optimize_plane(case, start, th, cone_deg=cone_deg, offset_mm=offset_mm)
    if not res.feasible and allow_wide:
        far = optimize_around(case, start, th)
        if far is not None and quality(far, th) > quality(res, th) + 0.5:
            return far, "wide"
    return res, "local"
