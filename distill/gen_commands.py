"""Generate the surgeon-command set (CLAUDE.md section 5.1).

    templates x phrasings x slot values x cases  ->  distill/data/commands.jsonl

Each row: {id, case_id, template, text, goal, setup, steps, split}.

With --paraphrase, Nemotron 3 Super on Token Factory rewrites every phrasing
into more surgeon-style variants first (the teacher's first job) and caches
them in distill/data/paraphrases.json; later runs reuse that file offline.
Without the file, only the hand-written phrasings are used.

Split is by case: test cases never appear in training. DECISION: with fewer
than three cases of a kind (true until the VISTA-3D gallery lands in M2), a
kind cannot be split by case, so its test split is held out by template
phrasing instead and DATASET.md says so.

    cd backend && uv run python ../distill/gen_commands.py --n 6000 [--paraphrase]
"""

from __future__ import annotations

import argparse
import itertools
import json
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "distill"))

from templates import CUT, STRUCTURE_IDS, TEMPLATES, Template  # noqa: E402

SEED = 20261020
OUT = ROOT / "distill" / "data" / "commands.jsonl"
# DECISION: the teacher's paraphrases (temperature 0.7) are cached and committed,
# so the command set rebuilds exactly; delete the file to ask Super again.
PARAPHRASES = ROOT / "distill" / "data" / "paraphrases.json"


def cases_by_kind() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for meta in sorted((ROOT / "public" / "data").glob("*/meta.json")):
        m = json.loads(meta.read_text())
        out.setdefault(m["kind"], []).append(m["id"])
    return out


def paraphrase(t: Template, client, model: str, k: int = 20) -> tuple[str, ...]:
    """Ask the teacher for k more phrasings that keep every {slot}."""
    prompt = (
        "Rewrite each request below as a vascular or liver surgeon might say it to a voice assistant in the OR: "
        f"terse, informal, sometimes slang. Give {k} new variants in total, one per line, no numbering. "
        "Keep every {placeholder} exactly as written and add no numbers.\n\n" + "\n".join(t.phrasings)
    )
    resp = client.chat.completions.create(model=model, messages=[{"role": "user", "content": prompt}], temperature=0.7, max_tokens=4000)
    # DECISION: 4000 tokens. Super reasons before answering; at 400 the reasoning
    # used the whole budget and most templates came back with no variants.
    lines = [ln.strip(" -•\t") for ln in (resp.choices[0].message.content or "").splitlines()]
    keep = [ln for ln in lines if ln and all(f"{{{s}}}" in ln for s in t.slots if any(f"{{{s}}}" in p for p in t.phrasings))]
    return t.phrasings + tuple(dict.fromkeys(keep))


def expand(t: Template, phrasings: tuple[str, ...]) -> list[tuple[str, str, int, dict]]:
    """(text, goal, phrasing index, slots) for every phrasing x slot combination."""
    keys = list(t.slots)
    rows = []
    for values in itertools.product(*(t.slots[k] for k in keys)) if keys else [()]:
        slot = dict(zip(keys, values))
        for name in ("v", "s"):
            if name in slot:
                slot[name + "id"] = STRUCTURE_IDS.get(slot[name], slot[name])
        goal = t.goal.format(**slot)
        for i, p in enumerate(phrasings):
            try:
                rows.append((p.format(**slot), goal, i, slot))
            except (KeyError, IndexError):
                continue
    return rows


def starts(t: Template, rng: random.Random, k: int) -> list[list]:
    """Setups to run before the request. A template that needs a cut gets the
    default cut plus k-1 random ones (offset +-15 mm, tilt +-15 deg), so the
    same words meet different engine states and need different answers."""
    if list(t.setup) != list(CUT):
        return [[list(x) for x in t.setup]]
    out = [[list(x) for x in CUT]]
    for _ in range(k - 1):
        out.append([
            ["set_plane", {"offset_mm": rng.randint(-15, 15)}],
            ["set_plane", {"rotate_deg": {"axis": rng.choice("yz"), "deg": rng.randint(-15, 15)}}],
        ])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--paraphrase", action="store_true")
    ap.add_argument("--starts", type=int, default=6, help="starting planes per liver command that needs a cut")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    rng = random.Random(SEED)
    phr = {t.id: t.phrasings for t in TEMPLATES}
    cache = json.loads(PARAPHRASES.read_text()) if PARAPHRASES.exists() else {}
    if args.paraphrase:
        from openai import OpenAI

        from app import config

        s = config.load()
        if not (s.tf_api_key and s.model_super):
            sys.exit("--paraphrase needs NEBIUS_TF_API_KEY and NEBIUS_TF_MODEL_SUPER")
        client = OpenAI(api_key=s.tf_api_key, base_url=s.tf_base_url)
        for t in TEMPLATES:
            if t.id not in cache:
                cache[t.id] = list(paraphrase(t, client, s.model_super))
        PARAPHRASES.write_text(json.dumps(cache, indent=1, ensure_ascii=False) + "\n")
    for t in TEMPLATES:
        if t.id in cache:
            phr[t.id] = tuple(cache[t.id])

    kinds = cases_by_kind()
    pool = []
    for t in TEMPLATES:
        cases = kinds.get(t.kind, [])
        test_cases = set(cases[-max(1, len(cases) // 5):]) if len(cases) >= 3 else set()
        for text, goal, pi, slot in expand(t, phr[t.id]):
            for c, setup in ((c, st) for c in cases for st in starts(t, rng, args.starts)):
                if test_cases:
                    split = "test" if c in test_cases else "train"
                else:
                    # Held out by phrasing: the last phrasing of each template is test only.
                    split = "test" if pi == len(phr[t.id]) - 1 and len(phr[t.id]) > 1 else "train"
                pool.append({"case_id": c, "template": t.id, "text": text, "goal": goal, "slots": slot,
                             "setup": setup, "steps": t.steps, "split": split})

    rng.shuffle(pool)
    # DECISION: never pad with duplicates. Without --paraphrase the pool is
    # smaller than --n and the set is just the pool; the teacher's paraphrases
    # are what reach the target size.
    rows = pool[: args.n]
    # Validation: a tenth of train, by fixed draw.
    for r in rows:
        if r["split"] == "train" and rng.random() < 0.1:
            r["split"] = "val"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for i, r in enumerate(rows):
            f.write(json.dumps({"id": f"c{i:05d}", **r}) + "\n")

    by_split = Counter(r["split"] for r in rows)
    by_t = Counter(r["template"] for r in rows)
    print(f"{len(rows)} commands ({len(pool)} unique) -> {args.out}")
    print("splits:", dict(by_split))
    print("clarify share: {:.1%}".format(sum(v for k, v in by_t.items() if k.startswith("clarify")) / len(rows)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
