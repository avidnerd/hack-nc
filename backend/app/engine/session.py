"""One planning session: the Python twin of the slice of src/state.ts the agent
tools read and write.

The plane starts where the app starts it (normal +x through the organ
centroid, switched off); `plane_on` turns true once a tool places a cut. The
stent, thresholds, visibility, preset and resect flag follow the app's
defaults for the case kind.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .grid import Case, load_case
from .metrics import Plane, normalize
from .optimize import Thresholds
from .stent import Centerline, Ostium, StentState, ostia_on_centerline

# Hidden by default (state.ts defaultVisibility).
AORTA_CASE_HIDDEN = {"skin", "hepatic_vessels", "portal_vein"}


@dataclass
class Session:
    case: Case
    mode: str = "surgeon"
    plane: Plane = field(default_factory=lambda: Plane((1.0, 0.0, 0.0), 0.0))
    plane_on: bool = False
    stent: StentState | None = None
    device_id: str | None = None
    thresholds: Thresholds = field(default_factory=Thresholds)
    # Threshold names the user (or agent on the user's behalf) set this session.
    user_thresholds: set[str] = field(default_factory=set)
    visible: dict[str, bool] = field(default_factory=dict)
    highlight: list[str] = field(default_factory=list)
    preset: str = "soft"
    resected: bool = False

    @classmethod
    def open(cls, case_id: str) -> Session:
        case = load_case(case_id)
        s = cls(case)
        c = case.grid.organ_centroid()
        if c is None:
            m = case.meta
            c = [m["origin"][k] + (m["shape"][k] - 1) * m["spacing"][k] / 2 for k in range(3)]
        s.plane = Plane((1.0, 0.0, 0.0), float(c[0]))
        hidden = AORTA_CASE_HIDDEN if case.kind == "aorta" else {"skin"}
        s.visible = {k: k not in hidden for k in case.keys}
        s.preset = case.meta.get("defaultPreset", "soft")
        return s

    def set_plane(self, n: Any, d: float) -> None:
        self.plane = Plane(normalize(n), float(d))
        self.plane_on = True
        self.resected = False

    # ----------------------------------------------------------- the aorta

    @property
    def centerline(self) -> Centerline | None:
        cache = self.__dict__.get("_cl")
        if cache is None:
            pts = (self.case.centerlines or {}).get("vessels", {}).get("aorta")
            cl = Centerline(pts) if pts and len(pts) > 1 else None
            ostia = ostia_on_centerline(cl, self.case.centerlines.get("renalOstia", [])) if cl else []
            cache = (cl, ostia)
            self.__dict__["_cl"] = cache
        return cache[0]

    @property
    def ostia(self) -> list[Ostium]:
        _ = self.centerline
        return self.__dict__["_cl"][1]
