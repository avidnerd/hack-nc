"""Live device rule lookup (CLAUDE.md section 7): Tavily search -> Nemotron 3
Super extraction -> verbatim validation -> a rule card in data/device_rules/.

    python -m app.rules "Gore Excluder"        (from backend/) look up and cache one device

Validation is string matching, not trust: a field is kept only if
  1. its quote appears in the text Tavily returned for its URL (whitespace,
     dash and <=/≤ differences normalised), and
  2. every number in its value appears as a number in that quote, and
  3. the quote names the quantity ("neck length", "diameter", "angulation",
     "oversiz"), so a bare "≥ 4 mm and ≤ 15 mm" cannot pass, and
  4. the value is in a plausible range (a neck length of 150 mm is a misread).
Anything else is dropped, with the reason, and the field shows as "not found";
the engine then keeps the default simplified rule for it.
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import date
from typing import Any

import httpx
from openai import OpenAI

from . import config
from .engine import device_rules
from .engine.device_rules import FIELDS, RULES_DIR

TAVILY_URL = "https://api.tavily.com/search"
FDA = "accessdata.fda.gov"
# Manufacturer domains by a word in the device name; FDA is always searched.
MAKERS = {
    "gore": ["goremedical.com"], "excluder": ["goremedical.com"],
    "medtronic": ["medtronic.com"], "endurant": ["medtronic.com"],
    "cook": ["cookmedical.com"], "zenith": ["cookmedical.com"],
    "endologix": ["endologix.com"], "afx": ["endologix.com"], "alto": ["endologix.com"],
    "terumo": ["terumoaortic.com"], "treo": ["terumoaortic.com"],
}
KEYWORDS = ("neck", "angulation", "oversiz", "diameter", "indicated")
WINDOW = 600  # characters kept around each keyword hit, per source
MAX_SOURCE_CHARS = 6000
PLAUSIBLE = {
    "neck_length_min_mm": (3, 40),
    "neck_diameter_mm": (10, 40),
    "neck_angulation_max_deg": (20, 120),
    "oversize_pct": (0, 40),
}

# Words the quote itself must contain for each field.
NAMES = {
    "neck_length_min_mm": ("length",),
    "neck_diameter_mm": ("diameter",),
    "neck_angulation_max_deg": ("angulation", "angle"),
    "oversize_pct": ("oversiz",),
}

PROMPT = """You extract stent graft sizing rules from instructions-for-use text. Device: {device}

Return only a JSON object with these keys. Each is either null or {{"value": ..., "quote": "...", "url": "..."}}:
- neck_length_min_mm: minimum proximal aortic neck length in mm (a number)
- neck_diameter_mm: aortic neck treatment diameter range in mm ([min, max])
- neck_angulation_max_deg: maximum proximal neck angulation in degrees (a number)
- oversize_pct: recommended device oversizing relative to the aortic neck in percent ([min, max])

Rules:
- "quote" is copied character for character from one source below, short (one sentence or clause), and contains the number(s).
- "url" is that source's URL.
- Use only the rules for this device, not for a sibling device described on the same page.
- Use the device's indications for use only. Ignore clinical trial inclusion criteria, study cohorts and case reports.
- If the text does not state a field, use null. Do not compute or infer values.

Sources:
{sources}"""


def _norm(t: str) -> str:
    t = t.replace("≤", "<=").replace("≥", ">=").replace(" ", " ")
    t = re.sub(r"[‐-―−]", "-", t)
    return re.sub(r"\s+", " ", t).strip().lower()


NUM = re.compile(r"\d+(?:\.\d+)?")


def _numbers(t: str) -> set[float]:
    return {float(x) for x in NUM.findall(t)}


def validate(field: str, item: Any, pages: dict[str, str]) -> tuple[dict[str, Any] | None, str | None]:
    """(kept item, None) or (None, why it was dropped)."""
    if not item:
        return None, None
    if not isinstance(item, dict) or not {"value", "quote", "url"} <= item.keys():
        return None, "malformed"
    v, quote, url = item["value"], str(item["quote"]), str(item["url"])
    vals = v if isinstance(v, list) else [v]
    want_pair = field in ("neck_diameter_mm", "oversize_pct")
    if (want_pair and len(vals) != 2) or (not want_pair and len(vals) != 1):
        return None, f"value {v!r} has the wrong shape"
    try:
        vals = [float(x) for x in vals]
    except (TypeError, ValueError):
        return None, f"value {v!r} is not numeric"
    if url not in pages:
        return None, f"url {url} was not a search result"
    if _norm(quote) not in _norm(pages[url]):
        return None, "quote not found verbatim in the source"
    if not any(w in _norm(quote) for w in NAMES[field]):
        return None, f"quote does not name the quantity ({' or '.join(NAMES[field])})"
    missing = [x for x in vals if x not in _numbers(quote)]
    if missing:
        return None, f"{missing} not in the quote"
    lo, hi = PLAUSIBLE[field]
    if not all(lo <= x <= hi for x in vals) or (want_pair and vals[0] > vals[1]):
        return None, f"value {vals} outside {lo} to {hi}"
    clean = [int(x) if x.is_integer() else x for x in vals]
    return {"value": clean if want_pair else clean[0], "quote": quote, "url": url}, None


def maker_domains(device: str) -> list[str]:
    return sorted({d for w in device_rules.norm_name(device).split() for d in MAKERS.get(w, [])})


def search(device: str, api_key: str, domains: list[str]) -> tuple[str, list[dict[str, Any]]]:
    query = f"{device} instructions for use indications aortic neck length diameter angulation oversizing"
    r = httpx.post(TAVILY_URL, headers={"Authorization": f"Bearer {api_key}"}, timeout=30, json={
        "query": query, "search_depth": "advanced", "max_results": 8,
        "include_raw_content": "text", "include_domains": domains,
    })
    r.raise_for_status()
    return query, r.json().get("results", [])


def excerpt(raw: str) -> str:
    """Keyword windows from a page, merged, so the prompt stays short."""
    low = raw.lower()
    spans: list[list[int]] = []
    for kw in KEYWORDS:
        for m in re.finditer(kw, low):
            a, b = max(0, m.start() - WINDOW // 2), min(len(raw), m.end() + WINDOW // 2)
            if spans and a <= spans[-1][1]:
                spans[-1][1] = max(spans[-1][1], b)
            else:
                spans.append([a, b])
    spans.sort()
    merged: list[list[int]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return " ... ".join(raw[a:b] for a, b in merged)[:MAX_SOURCE_CHARS]


def same_device(url: str, device: str) -> bool:
    """False for a product page of a sibling variant: "excluder-conformable" when "Excluder" was asked.

    A URL's product slug (the path segment after /products/) may only use
    words of the device name or its maker; pages without one (FDA) pass.
    """
    m = re.search(r"/products?/([a-z0-9-]+)", url.lower())
    if not m:
        return True
    words = set(device_rules.norm_name(device).split())
    allowed = words | {w for w in MAKERS if set(MAKERS[w]) & {d for x in words for d in MAKERS.get(x, [])}}
    return set(m.group(1).split("-")) <= allowed


def _json_object(text: str) -> dict[str, Any]:
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object in the extraction reply")
    return json.loads(m.group(0))


def lookup(device: str, settings: config.Settings | None = None, write: bool = True) -> dict[str, Any]:
    """Search, extract, validate; returns the card (and writes it to data/device_rules/)."""
    import os

    s = settings or config.load()
    key = os.environ.get("TAVILY_API_KEY")
    if not key or not s.tf_api_key or not s.model_super:
        raise RuntimeError("TAVILY_API_KEY, NEBIUS_TF_API_KEY and NEBIUS_TF_MODEL_SUPER are needed for a live lookup")
    t0 = time.time()
    client = OpenAI(api_key=s.tf_api_key, base_url=s.tf_base_url, max_retries=1)
    fields: dict[str, Any] = {}
    dropped: list[dict[str, Any]] = []
    searched: list[str] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0}
    query = ""
    # DECISION: the manufacturer's own domain first, FDA only for fields still
    # missing. FDA documents often cover a sibling variant: the first Gore
    # lookup took the Excluder Conformable's limits from its PMA (P200030).
    rounds = [d for d in (maker_domains(device), [FDA]) if d]
    for domains in rounds:
        if len(fields) == len(FIELDS):
            break
        query, results = search(device, key, domains)
        pages = {r["url"]: r.get("raw_content") or r.get("content") or "" for r in results}
        # Sibling-variant product pages are dropped before extraction too.
        pages = {u: t for u, t in pages.items() if t and same_device(u, device)}
        blocks = [f"[{u}]\n{excerpt(t)}" for u, t in pages.items() if excerpt(t)]
        searched += list(pages)
        if not blocks:
            continue
        reply = client.chat.completions.create(
            model=s.model_super, temperature=0, max_tokens=4000, timeout=60,
            messages=[{"role": "user", "content": PROMPT.format(device=device, sources="\n\n".join(blocks))}],
        )
        if reply.usage:
            usage["prompt_tokens"] += reply.usage.prompt_tokens
            usage["completion_tokens"] += reply.usage.completion_tokens
        raw = _json_object(reply.choices[0].message.content or "")
        for f in FIELDS:
            if f in fields:
                continue
            kept, why = validate(f, raw.get(f), pages)
            if kept:
                fields[f] = kept
            elif why:
                dropped.append({"field": f, "reason": why, "proposed": raw.get(f), "domains": domains})
    card = {
        "id": device_rules.slug(device),
        "device": device,
        "aliases": [device],
        "fetched": date.today().isoformat(),
        "query": query,
        "search_results": searched,
        "model": s.model_super,
        "fields": fields,
        "dropped": dropped,
        "timing_s": {"total": round(time.time() - t0, 2)},
        "usage": usage,
    }
    if write:
        RULES_DIR.mkdir(parents=True, exist_ok=True)
        (RULES_DIR / f"{card['id']}.json").write_text(json.dumps(card, indent=2, ensure_ascii=False) + "\n")
        device_rules.reload()
    return card


if __name__ == "__main__":
    for name in sys.argv[1:]:
        c = lookup(name)
        print(json.dumps({k: c[k] for k in ("id", "fields", "dropped", "timing_s")}, indent=2, ensure_ascii=False))
