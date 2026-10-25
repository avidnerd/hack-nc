"""The aortic stent graft: centerline, placement, sizing and seal rules.
A port of src/devices/{centerline,stent}.ts.

The centerline is the pipeline's ~2 mm samples of the aorta skeleton with the
lumen radius at each, linearly interpolated in arc length s (s = 0 is the
cranial end). The rules are the simplified EVAR checks, in this order:

    renal       covered graft starts at or below the lowest renal ostium and
                covers none
    neck length >= 10 mm of lumen within 10 % of the neck's mean diameter
                (mean over the first 15 mm), walked distally in 0.5 mm steps
    oversize    device diameter 10 to 20 % above that mean
    angulation  < 60 deg between centerline tangents at s0 and s0 + 15 mm

A fresh device is sized 15 % over the native neck at its seat.

A device's rule card (data/device_rules/, from its instructions for use) can
replace these limits: `Limits` carries the minimum neck length, the oversize
range (a fresh device is sized at its midpoint), the angulation maximum (IFUs
write it as "<= 60", so a card's is inclusive) and an optional neck diameter
range, checked after neck length. Anything the card does not state keeps the
default. The TS twin is src/devices/stent.ts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .metrics import angle_deg, normalize

STENT_LENGTH_MM = 80.0
RENAL_CLEARANCE_MM = 2.0
NECK_WINDOW_MM = 15.0
OVERSIZE = 0.15
FALLBACK_S0 = 30.0
RULES = {
    "neck_min_mm": 10.0,
    "oversize_min_pct": 10.0,
    "oversize_max_pct": 20.0,
    "angulation_max_deg": 60.0,
    "neck_deviation": 0.1,
}


@dataclass(frozen=True)
class Limits:
    neck_min_mm: float = RULES["neck_min_mm"]
    oversize_min_pct: float = RULES["oversize_min_pct"]
    oversize_max_pct: float = RULES["oversize_max_pct"]
    angulation_max_deg: float = RULES["angulation_max_deg"]
    angulation_inclusive: bool = False
    neck_diameter_mm: tuple[float, float] | None = None
    source: str = "default"
    # Which fields came from the card (the rest are defaults).
    from_card: tuple[str, ...] = field(default=())

    @property
    def oversize(self) -> float:
        """Fraction a fresh device is sized over the neck: the range midpoint (0.15 by default)."""
        return (self.oversize_min_pct + self.oversize_max_pct) / 200


DEFAULT_LIMITS = Limits()


class Centerline:
    def __init__(self, points: list[dict[str, Any]]):
        if len(points) < 2:
            raise ValueError("centerline needs at least two points")
        self.p = np.array([q["p"] for q in points], dtype=np.float64)
        self.r = np.array([q["r"] for q in points], dtype=np.float64)
        self.t = np.array([q["t"] for q in points], dtype=np.float64)
        s = [0.0]
        for i in range(1, len(points)):
            a, b = self.p[i], self.p[i - 1]
            s.append(s[-1] + math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2))
        self.s = np.array(s)
        self.length = float(self.s[-1])

    def _locate(self, s: float) -> tuple[int, float]:
        n = len(self.s)
        if s <= 0:
            return 0, 0.0
        if s >= self.length:
            return n - 2, 1.0
        lo = int(np.searchsorted(self.s, s, side="right")) - 1
        span = self.s[lo + 1] - self.s[lo]
        return lo, (s - self.s[lo]) / span if span > 0 else 0.0

    def point_at(self, s: float) -> list[float]:
        i, t = self._locate(s)
        a, b = self.p[i], self.p[i + 1]
        return [float(a[k] + (b[k] - a[k]) * t) for k in range(3)]

    def radius_at(self, s: float) -> float:
        i, t = self._locate(s)
        return float(self.r[i] + (self.r[i + 1] - self.r[i]) * t)

    def tangent_at(self, s: float) -> tuple[float, float, float]:
        i, t = self._locate(s)
        a, b = self.t[i], self.t[i + 1]
        return normalize([a[k] + (b[k] - a[k]) * t for k in range(3)])

    def nearest_s(self, p: Any) -> float:
        d = np.sqrt(((self.p - np.asarray(p, dtype=np.float64)) ** 2).sum(axis=1))
        return float(self.s[int(np.argmin(d))])

    def mean_diameter(self, a: float, b: float) -> float:
        """Mean lumen diameter over [a, b], sampled every 1 mm."""
        lo = max(0.0, min(a, b))
        hi = min(self.length, max(a, b))
        total = 0.0
        n = 0
        s = lo
        while s <= hi + 1e-9:
            total += 2 * self.radius_at(s)
            n += 1
            s += 1
        return total / n if n > 0 else 2 * self.radius_at(lo)


@dataclass
class Ostium:
    s: float
    side: str


@dataclass
class StentState:
    s0: float
    length_mm: float
    diameter_mm: float
    neck_mm: float
    neck_mean_mm: float
    oversize_pct: float
    angulation_deg: float
    renal_clearance_mm: float | None
    renal_covered: int
    fail_reason: str | None

    @property
    def seals(self) -> bool:
        return self.fail_reason is None


def ostia_on_centerline(cl: Centerline, ostia: list[dict[str, Any]]) -> list[Ostium]:
    return [Ostium(cl.nearest_s(o["p"]), o["side"]) for o in ostia]


def lowest_renal(ostia: list[Ostium]) -> float | None:
    return max(o.s for o in ostia) if ostia else None


def preferred_start(ostia: list[Ostium], fallback: float) -> float:
    lowest = lowest_renal(ostia)
    return fallback if lowest is None else lowest + RENAL_CLEARANCE_MM


def size_at(cl: Centerline, s0: float, lim: Limits = DEFAULT_LIMITS) -> float:
    return (1 + lim.oversize) * cl.mean_diameter(s0, s0 + NECK_WINDOW_MM)


def max_start(cl: Centerline, length_mm: float = STENT_LENGTH_MM) -> float:
    return max(0.0, cl.length - length_mm)


def angulation_ok(angulation: float, lim: Limits) -> bool:
    return angulation <= lim.angulation_max_deg if lim.angulation_inclusive else angulation < lim.angulation_max_deg


def neck_diameter_ok(neck_mean: float, lim: Limits) -> bool:
    return lim.neck_diameter_mm is None or lim.neck_diameter_mm[0] <= neck_mean <= lim.neck_diameter_mm[1]


def evaluate_stent(cl: Centerline, ostia: list[Ostium], s0: float, diameter_mm: float,
                   length_mm: float = STENT_LENGTH_MM, lim: Limits = DEFAULT_LIMITS) -> StentState:
    s1 = s0 + length_mm
    neck_mean = cl.mean_diameter(s0, s0 + NECK_WINDOW_MM)
    neck = 0.0
    s = s0
    while s <= s1:
        if abs(2 * cl.radius_at(s) - neck_mean) > RULES["neck_deviation"] * neck_mean:
            break
        neck = s - s0
        s += 0.5
    oversize = (diameter_mm / neck_mean - 1) * 100
    angulation = angle_deg(cl.tangent_at(s0), cl.tangent_at(s0 + NECK_WINDOW_MM))
    covered = [o for o in ostia if s0 <= o.s <= s1]
    lowest = lowest_renal(ostia)

    fail = None
    if covered:
        fail = "Renal arteries covered" if len(covered) > 1 else f"{covered[0].side.capitalize()} renal artery covered"
    elif lowest is not None and s0 < lowest:
        fail = "Above the renal arteries"
    elif neck < lim.neck_min_mm:
        fail = f"Neck too short, {_js_round(neck)} millimeters"
    elif not neck_diameter_ok(neck_mean, lim):
        # One decimal: whole millimetres would read "19" for an 18.6 mm neck against a 19 mm minimum.
        lo, hi = lim.neck_diameter_mm
        side = f"below the device minimum of {_js_num(lo)}" if neck_mean < lo else f"above the device maximum of {_js_num(hi)}"
        fail = f"Neck diameter {_js_num(_js_round(neck_mean * 10) / 10)} millimeters, {side}"
    elif oversize < lim.oversize_min_pct:
        fail = f"Undersized, {_js_round(oversize)} percent oversize"
    elif oversize > lim.oversize_max_pct:
        fail = f"Oversized, {_js_round(oversize)} percent"
    elif not angulation_ok(angulation, lim):
        fail = f"Neck angled {_js_round(angulation)} degrees"
    return StentState(s0, length_mm, diameter_mm, neck, neck_mean, oversize, angulation,
                      None if lowest is None else s0 - lowest, len(covered), fail)


def rules(st: StentState, lim: Limits = DEFAULT_LIMITS) -> list[dict[str, Any]]:
    """Per-rule pass/fail with the measured value and the limit, in check order.

    neck_diameter appears only when the device's card gives a range.
    """
    renal_ok = st.renal_covered == 0 and (st.renal_clearance_mm is None or st.renal_clearance_mm >= 0)
    out = [
        {"id": "renal", "pass": renal_ok, "value": st.renal_clearance_mm, "limit": 0.0, "unit": "mm"},
        {"id": "neck_length", "pass": st.neck_mm >= lim.neck_min_mm, "value": st.neck_mm,
         "limit": lim.neck_min_mm, "unit": "mm"},
    ]
    if lim.neck_diameter_mm is not None:
        out.append({"id": "neck_diameter", "pass": neck_diameter_ok(st.neck_mean_mm, lim), "value": st.neck_mean_mm,
                    "limit": list(lim.neck_diameter_mm), "unit": "mm"})
    out += [
        {"id": "oversize", "pass": lim.oversize_min_pct <= st.oversize_pct <= lim.oversize_max_pct,
         "value": st.oversize_pct, "limit": [lim.oversize_min_pct, lim.oversize_max_pct], "unit": "%"},
        {"id": "angulation", "pass": angulation_ok(st.angulation_deg, lim), "value": st.angulation_deg,
         "limit": lim.angulation_max_deg, "unit": "deg"},
    ]
    return out


def place_stent(cl: Centerline, ostia: list[Ostium], prefer_s0: float | None = None,
                length_mm: float = STENT_LENGTH_MM, lim: Limits = DEFAULT_LIMITS) -> StentState:
    """Scan every 1 mm start, size each, and take the sealing seat nearest `prefer_s0`."""
    if prefer_s0 is None:
        prefer_s0 = preferred_start(ostia, 0.0)
    hi = max_start(cl, length_mm)
    best = None
    s0 = 0.0
    while s0 <= hi:
        st = evaluate_stent(cl, ostia, s0, size_at(cl, s0, lim), length_mm, lim)
        if st.seals and (best is None or abs(s0 - prefer_s0) < abs(best.s0 - prefer_s0)):
            best = st
        s0 += 1
    if best is not None:
        return best
    s0 = min(max(prefer_s0, 0.0), hi)
    return evaluate_stent(cl, ostia, s0, size_at(cl, s0, lim), length_mm, lim)


def rule_of_reason(reason: str | None) -> str | None:
    """The rule id behind a fail reason ("Neck too short, 8 millimeters" is neck_length)."""
    if not reason:
        return None
    if reason.startswith("Neck too short"):
        return "neck_length"
    if reason.startswith("Neck diameter"):
        return "neck_diameter"
    if reason.startswith("Neck angled"):
        return "angulation"
    if reason.startswith(("Undersized", "Oversized")):
        return "oversize"
    if "renal" in reason.lower():
        return "renal"
    return None


def optimize_stent(cl: Centerline, ostia: list[Ostium], current: StentState,
                   range_mm: int = 40, lim: Limits = DEFAULT_LIMITS) -> tuple[StentState | None, float, str | None]:
    """Slide the chosen device +-40 mm in 1 mm steps (nearest first) to the nearest sealing seat.

    Returns (stent, moved mm, blocker): the blocker is the failure reason seen
    most often across the search when nothing seals.
    """
    hi = max_start(cl, current.length_mm)
    tally: dict[str, int] = {}
    for step in range(range_mm + 1):
        for sign in ((1,) if step == 0 else (-1, 1)):
            s0 = current.s0 + sign * step
            if s0 < 0 or s0 > hi:
                continue
            st = evaluate_stent(cl, ostia, s0, current.diameter_mm, current.length_mm, lim)
            if st.seals:
                return st, s0 - current.s0, None
            key = (st.fail_reason or "").split(",")[0]
            tally[key] = tally.get(key, 0) + 1
    blocker = None
    most = 0
    for k, n in tally.items():
        if n > most:
            most, blocker = n, k
    return None, 0.0, blocker


def _js_round(x: float) -> int:
    """Math.round: halves go up."""
    return int(math.floor(x + 0.5))


def _js_num(x: float) -> str:
    """A number as JS String() writes it for these values: 19 not 19.0, 18.6 as 18.6."""
    return str(int(x)) if float(x).is_integer() else repr(float(x))
