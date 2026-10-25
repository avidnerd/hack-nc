"""Device rule cards: a stent graft's sizing limits from its instructions for use.

Cards live in data/device_rules/<id>.json (committed) and are written by
app/rules.py, which searches with Tavily, extracts with Nemotron 3 Super and
keeps a field only if its number appears verbatim in a quote that appears
verbatim in the source page. This module only reads them: no network, so the
engine stays deterministic for eval and data generation. The TS twin is
src/devices/deviceRules.ts.

Card fields (each `{value, quote, url}` or absent):
    neck_length_min_mm        number
    neck_diameter_mm          [min, max]
    neck_angulation_max_deg   number (inclusive)
    oversize_pct              [min, max]
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .stent import DEFAULT_LIMITS, Limits

RULES_DIR = Path(__file__).resolve().parents[3] / "data" / "device_rules"
FIELDS = ("neck_length_min_mm", "neck_diameter_mm", "neck_angulation_max_deg", "oversize_pct")
# Words that do not tell devices apart ("Gore Excluder AAA endoprosthesis" is "gore excluder").
FILLER = {"aaa", "endoprosthesis", "stent", "graft", "stentgraft", "endovascular", "system", "device", "the", "a", "an",
          "abdominal", "aortic", "bifurcated", "for", "r", "tm"}


def norm_name(name: str) -> str:
    words = re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).split()
    return " ".join(w for w in words if w not in FILLER)


def slug(name: str) -> str:
    return norm_name(name).replace(" ", "-")


@lru_cache(maxsize=1)
def _cards() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    # DECISION: distill/ (teacher traces, verifier, eval) sets
    # SCRUB_DEVICE_RULES=0, so every model row is scored on the same default
    # rules the training data was verified against.
    if os.environ.get("SCRUB_DEVICE_RULES", "1") == "0":
        return out
    if RULES_DIR.is_dir():
        for f in sorted(RULES_DIR.glob("*.json")):
            card = json.loads(f.read_text())
            out[card["id"]] = card
    return out


def reload() -> None:
    _cards.cache_clear()


def find(name: str | None) -> dict[str, Any] | None:
    """The card for a device name or id: exact id, then an alias, then a unique id containing every word."""
    if not name:
        return None
    key = norm_name(name)
    cards = _cards()
    if not key:
        return None
    if key.replace(" ", "-") in cards:
        return cards[key.replace(" ", "-")]
    for c in cards.values():
        if key in (norm_name(a) for a in c.get("aliases", [])):
            return c
    words = set(key.split())
    hits = [c for c in cards.values() if words <= set(c["id"].split("-"))]
    return hits[0] if len(hits) == 1 else None


def limits_of(card: dict[str, Any] | None) -> Limits:
    if card is None:
        return DEFAULT_LIMITS
    f = card.get("fields", {})
    d = DEFAULT_LIMITS
    used = tuple(k for k in FIELDS if f.get(k))
    ov = f.get("oversize_pct")
    nd = f.get("neck_diameter_mm")
    return Limits(
        neck_min_mm=float(f["neck_length_min_mm"]["value"]) if f.get("neck_length_min_mm") else d.neck_min_mm,
        oversize_min_pct=float(ov["value"][0]) if ov else d.oversize_min_pct,
        oversize_max_pct=float(ov["value"][1]) if ov else d.oversize_max_pct,
        angulation_max_deg=float(f["neck_angulation_max_deg"]["value"]) if f.get("neck_angulation_max_deg") else d.angulation_max_deg,
        angulation_inclusive=bool(f.get("neck_angulation_max_deg")),
        neck_diameter_mm=(float(nd["value"][0]), float(nd["value"][1])) if nd else None,
        source=f"ifu:{card['id']}",
        from_card=used,
    )


def card_json(card: dict[str, Any]) -> dict[str, Any]:
    """The lookup_device_rules result: limits, where each came from, and what the card lacks."""
    f = card.get("fields", {})
    return {
        "device_id": card["id"],
        "device": card["device"],
        "rules": {k: f[k]["value"] for k in FIELDS if f.get(k)},
        "not_found": [k for k in FIELDS if not f.get(k)],
        "sources": [{"field": k, "url": f[k]["url"], "quote": f[k]["quote"]} for k in FIELDS if f.get(k)],
        "rules_source": f"ifu:{card['id']}",
        "fetched": card.get("fetched"),
    }
