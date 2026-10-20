"""Surgeon-request templates for the distillation set (CLAUDE.md section 5.1).

Each template is a family of phrasings, the slot values it takes, the setup
the engine runs before the request (so "nudge it" has a cut to nudge), and a
goal: a predicate over the finished turn that the engine checks. The goal is
what makes the data verified rather than generated: a trace is kept only when
the engine agrees the request was done.

Goal predicates are Python expressions evaluated by verify.py with these names:
    called(name, **args)   a tool call with those arguments was made this turn
    th                     final thresholds {margin_min_mm, flr_min_pct}
    plan                   final write_plan result
    state                  final get_state result
    said(x)                the final text states x (at any precision it rounds to)
    clarified              the reply is a question and no tool changed the plan
    d_moved                |d_after - d_before| of the plane, mm
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Setup the engine runs before the request: a default cut through the organ.
CUT = [("set_plane", {"offset_mm": 0})]


@dataclass(frozen=True)
class Template:
    id: str
    kind: str  # "liver" | "aorta"
    phrasings: tuple[str, ...]
    slots: dict[str, tuple[Any, ...]] = field(default_factory=dict)
    goal: str = "True"
    setup: tuple[tuple[str, dict[str, Any]], ...] = ()
    steps: int = 1  # tool calls a good answer needs (for router "multi-step")


T = Template

TEMPLATES: list[Template] = [
    # ------------------------------------------------------------ liver: optimize
    T("opt_margin", "liver", (
        "optimize the cut with at least a {m} mm margin",
        "find me a plane with {m} mm of margin",
        "Scrub, optimize for a {m} millimetre margin",
        "give me {m} mm clear of the tumor and optimize",
        "best cut with a {m} mm margin please",
    ), {"m": (5, 8, 10, 12, 15)}, "called('optimize_plane', margin_min_mm={m})", CUT),
    T("opt_flr", "liver", (
        "optimize but keep at least {p} percent of the liver",
        "find a cut that leaves {p}% remnant",
        "optimize with a remnant floor of {p} percent",
        "I need {p} percent future liver remnant, optimize",
    ), {"p": (25, 30, 35, 40)}, "called('optimize_plane', flr_min_pct={p})", CUT),
    T("opt_avoid", "liver", (
        "nudge it off the {v} a bit",
        "keep the cut away from the {v}",
        "optimize and don't divide the {v}",
        "spare the {v}",
    ), {"v": ("portal vein", "hepatic vessels", "IVC")}, "called('optimize_plane', avoid=['{vid}'])", CUT),
    T("opt_plain", "liver", (
        "optimize",
        "Scrub, optimize",
        "clean up this cut",
        "can you find a better plane",
    ), {}, "called('optimize_plane')", CUT),
    # ------------------------------------------------------------ liver: measure
    T("m_flr", "liver", (
        "how much liver is left",
        "what's the remnant",
        "FLR?",
        "what percentage do we keep",
    ), {}, "called('measure', what='flr') and said(result('measure')['value'])", CUT),
    T("m_margin", "liver", (
        "what's my margin",
        "how close am I to the tumor",
        "margin?",
        "how much clearance from the lesion",
    ), {}, "called('measure', what='margin') and said(result('measure')['value'])", CUT),
    T("m_vessels", "liver", (
        "how many vessels am I crossing",
        "am I cutting any vessels",
        "vessel count",
    ), {}, "called('measure', what='vessels_crossed')", CUT),
    T("m_tumor", "liver", (
        "how big is the tumor",
        "tumor volume",
        "what's the lesion volume in mL",
    ), {}, "called('measure', what='tumor_volume') and said(result('measure')['value'])"),
    # ------------------------------------------------------------ liver: plane
    T("nudge", "liver", (
        "move the plane {k} mm toward the tumor",
        "shift the cut {k} millimetres",
        "nudge it {k} mm",
        "slide the plane over {k} mm",
    ), {"k": (2, 3, 5, 8, 10)}, "abs(d_moved - {k}) < 0.15", CUT),
    T("rotate", "liver", (
        "tilt the cut {deg} degrees about the {axis} axis",
        "rotate the plane {deg} degrees around {axis}",
        "angle it {deg} degrees on {axis}",
    ), {"deg": (5, 10, 15, 20), "axis": ("x", "y", "z")}, "called('set_plane', rotate_deg={{'axis': '{axis}', 'deg': {deg}}}) or called('set_plane', rotate_deg={{'axis': '{axis}', 'deg': -{deg}}})", CUT),
    T("thr_margin", "liver", (
        "set the margin target to {m} mm",
        "margin threshold {m} millimetres",
        "I want {m} mm margins from now on",
    ), {"m": (5, 8, 10, 12, 15)}, "th['margin_min_mm'] == {m}"),
    T("thr_flr", "liver", (
        "set the remnant floor to {p} percent",
        "minimum FLR {p}%",
    ), {"p": (20, 25, 30, 35, 40)}, "th['flr_min_pct'] == {p}"),
    T("resect", "liver", (
        "resect",
        "take it out",
        "Scrub, resect",
        "do the resection",
    ), {}, "plan['resected'] and said(result('resect')['resected_ml'])", CUT),
    T("show_iso", "liver", (
        "show only the {s}",
        "isolate the {s}",
        "just the {s} please",
    ), {"s": ("tumor", "liver", "portal vein", "hepatic vessels")}, "state['visible'] == ['{sid}']"),
    T("hide", "liver", (
        "hide the {s}",
        "get rid of the {s}",
    ), {"s": ("IVC", "portal vein", "hepatic vessels")}, "'{sid}' not in state['visible']"),
    T("window", "liver", (
        "{w} window",
        "switch to the {w} preset",
        "show me {w} windowing",
    ), {"w": ("bone", "soft", "liver", "lung")}, "called('window', preset='{w}')"),
    T("plan", "liver", (
        "write the plan",
        "summarize the plan",
        "generate the plan note",
    ), {}, "called('write_plan')", CUT),
    # ------------------------------------------------------------ liver: multi-step
    T("multi_opt_resect", "liver", (
        "set the margin to {m} mm, optimize, then resect",
        "optimize with {m} mm margin and take it out",
        "{m} mm margin, optimize and resect",
    ), {"m": (5, 10, 12)}, "th['margin_min_mm'] == {m} and called('optimize_plane') and plan['resected']", CUT, steps=2),
    T("multi_thr_opt", "liver", (
        "keep {p} percent remnant and {m} mm margin, then optimize",
        "optimize for {m} mm margin with at least {p}% left",
    ), {"m": (8, 10), "p": (30, 35)}, "th['margin_min_mm'] == {m} and th['flr_min_pct'] == {p} and called('optimize_plane')", CUT, steps=2),
    # ------------------------------------------------------------ clarify (~5%)
    T("clarify", "liver", (
        "make it safe",
        "fix it",
        "do the usual",
        "make it better",
    ), {}, "clarified", CUT),
    # ------------------------------------------------------------ aorta
    T("stent", "aorta", (
        "place a stent",
        "size a {dev}",
        "put in a {dev} graft",
        "Scrub, place the {dev}",
    ), {"dev": ("generic", "Gore Excluder", "Medtronic Endurant")}, "plan['stent'] is not None"),
    T("stent_at", "aorta", (
        "place the stent at {s} mm",
        "seat the graft {s} mm down the centerline",
        "put the proximal end at {s} mm",
    ), {"s": (20, 30, 40, 50, 60)}, "plan['stent'] is not None and abs(plan['stent']['s0_mm'] - {s}) < 0.6"),
    T("stent_opt", "aorta", (
        "find a seat that seals",
        "optimize the stent",
        "make it seal",
    ), {}, "called('optimize_stent')", (("place_stent", {"device_id": "generic", "s0_mm": 10}),)),
    T("neck", "aorta", (
        "how long is the neck",
        "neck length?",
        "what's the neck diameter",
        "measure the neck diameter",
    ), {}, "(called('measure', what='neck_length') or called('measure', what='neck_diameter')) and said(result('measure')['value'])"),
    T("clarify_aorta", "aorta", (
        "make it safe",
        "fix the stent",
    ), {}, "clarified", (("place_stent", {"device_id": "generic", "s0_mm": 10}),)),
]

# Spoken structure names to ids.
STRUCTURE_IDS = {
    "portal vein": "portal_vein",
    "hepatic vessels": "hepatic_vessels",
    "IVC": "ivc",
    "tumor": "tumor",
    "liver": "liver",
}
