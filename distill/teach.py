"""Teacher traces (CLAUDE.md section 5.2): Nemotron 3 Super on Token Factory
solves every command, with the Python engine executing its tool calls.

    cd backend && uv run python ../distill/teach.py [--split train,val] [--limit N] [--workers 8]
    cd backend && uv run python ../distill/teach.py --oracle   # pipeline self-check, no network

Writes distill/data/traces_<model>.jsonl (one full trace per line), resuming
past ids already in the file, then run verify.py on it.
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "distill"))

import loop  # noqa: E402

DATA = ROOT / "distill" / "data"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--split", default="train,val")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--oracle", action="store_true")
    args = ap.parse_args()

    cmds = [json.loads(ln) for ln in (DATA / "commands.jsonl").read_text().splitlines()]
    cmds = [c for c in cmds if c["split"] in args.split.split(",")]
    if args.limit:
        cmds = cmds[: args.limit]

    if args.oracle:
        import oracle

        model = "oracle"

        def client_for(c):
            return oracle.OracleClient(c)
    else:
        from openai import OpenAI

        from app import config

        s = config.load()
        if not (s.tf_api_key and s.model_super):
            sys.exit("needs NEBIUS_TF_API_KEY and NEBIUS_TF_MODEL_SUPER in .env")
        tf = OpenAI(api_key=s.tf_api_key, base_url=s.tf_base_url, max_retries=2)
        model = s.model_super

        def client_for(c):
            return tf

    out = DATA / f"traces_{model.replace('/', '_')}.jsonl"
    done = set()
    if out.exists():
        done = {json.loads(ln)["id"] for ln in out.read_text().splitlines() if ln.strip()}
    todo = [c for c in cmds if c["id"] not in done]
    print(f"{len(todo)} to run ({len(done)} already in {out.name})")

    with out.open("a") as f, ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(loop.solve, client_for(c), model, c): c for c in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            f.write(json.dumps(fut.result()) + "\n")
            f.flush()
            if i % 50 == 0:
                print(f"  {i}/{len(todo)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
