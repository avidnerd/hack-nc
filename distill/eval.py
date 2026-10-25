"""Evaluate models on the held-out test commands (CLAUDE.md section 5.6).

    cd backend && uv run python ../distill/eval.py run --model super      # Token Factory
    cd backend && uv run python ../distill/eval.py run --model nano-tf    # Token Factory, Nemotron 3 Nano 30B
    cd backend && uv run python ../distill/eval.py run --model nano       # our endpoint, base weights
    cd backend && uv run python ../distill/eval.py run --model nano-lora  # our endpoint, + LoRA
    cd backend && uv run python ../distill/eval.py report                 # -> metrics/results.json

Each run writes distill/data/eval_<name>.jsonl (one verified trace per test
command, resuming). `report` scores every eval file it finds with the same
verifier the training set went through:

    success      goal predicate holds on the finished engine state
    schema       every tool call validated against shared/tools.json
    grounded     the model's own final text passed ground_check
    latency      request to final tool call, ms (median, p95)
    cost/1k      Token Factory: tokens x price per token (PRICES below)
                 our endpoint: GPU-seconds x GPU price, from metrics/spend.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "distill"))

import loop  # noqa: E402
import verify  # noqa: E402
from app import agent  # noqa: E402

DATA = ROOT / "distill" / "data"
METRICS = ROOT / "metrics"

# USD per 1M tokens (in, out), from GET /v1/models?verbose=true on 2026-10-22
# (metrics/tf_models.json, docs/PLATFORM_NOTES.md).
PRICES: dict[str, tuple[float, float]] = {
    "nvidia/nemotron-3-super-120b-a12b": (0.30, 0.90),
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": (0.06, 0.24),
}


def p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))]


def score(rows: list[dict[str, Any]], name: str) -> dict[str, Any]:
    n = len(rows)
    v = [r["verify"] for r in rows]
    lat = [r["tool_latency_ms"] for r in rows if r.get("tool_latency_ms") is not None and not r.get("error")]
    tin = sum(r.get("prompt_tokens") or 0 for r in rows)
    tout = sum(r.get("completion_tokens") or 0 for r in rows)
    model = rows[0]["model"] if rows else name
    cost = None
    method = "-"
    if model in PRICES:
        pin, pout = PRICES[model]
        cost = round((tin * pin + tout * pout) / 1e6 / n * 1000, 4)
        method = f"tokens x price ({pin}/{pout} USD per 1M in/out)"
    elif (METRICS / "spend.jsonl").exists():
        gpu = [json.loads(ln) for ln in (METRICS / "spend.jsonl").read_text().splitlines() if ln.strip()]
        run = [g for g in gpu if g.get("eval") == name]
        if run:
            usd = sum(g["gpu_seconds"] * g["usd_per_gpu_hour"] / 3600 for g in run)
            cost = round(usd / n * 1000, 4)
            method = "GPU-seconds x GPU price during the eval run"
    return {
        "name": name,
        "model": model,
        "n": n,
        "success": round(sum(x["goal"] for x in v) / n, 4) if n else None,
        "schema_valid": round(sum(x["schema_valid"] for x in v) / n, 4) if n else None,
        "grounded": round(sum(x["grounded"] for x in v) / n, 4) if n else None,
        "kept": round(sum(x["keep"] for x in v) / n, 4) if n else None,
        "latency_ms_median": statistics.median(lat) if lat else None,
        "latency_ms_p95": p95(lat),
        "errors": sum(1 for r in rows if r.get("error")),
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_per_1k_usd": cost,
        "cost_method": method,
    }


def client_for(name: str):
    from openai import OpenAI

    from app import config

    s = config.load()
    if name == "super":
        if not (s.tf_api_key and s.model_super):
            sys.exit("needs NEBIUS_TF_API_KEY and NEBIUS_TF_MODEL_SUPER")
        return OpenAI(api_key=s.tf_api_key, base_url=s.tf_base_url, max_retries=0), s.model_super
    if name == "nano-tf":
        # The Nano-family baseline Token Factory serves (Nano 9B v2 is not listed there).
        return OpenAI(api_key=s.tf_api_key, base_url=s.tf_base_url, max_retries=0), os.environ.get("NEBIUS_TF_MODEL_NANO", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")
    url = os.environ.get("NANO_BASE_URL")
    if not url:
        sys.exit("needs NANO_BASE_URL (the scrub-nano endpoint, .../v1)")
    # Served model names set by distill/serve/launch.sh.
    model = agent.NANO_LORA_NAME if name == "nano-lora" else agent.NANO_BASE_NAME
    return OpenAI(api_key=os.environ.get("NANO_API_KEY", "none"), base_url=url, max_retries=0), model


def run(name: str, workers: int, limit: int) -> None:
    cmds = [json.loads(ln) for ln in (DATA / "commands.jsonl").read_text().splitlines()]
    cmds = [c for c in cmds if c["split"] == "test"][: limit or None]
    out = DATA / f"eval_{name}.jsonl"
    done = {json.loads(ln)["id"] for ln in out.read_text().splitlines()} if out.exists() else set()
    if name == "oracle":
        import oracle

        def mk(c):
            return oracle.OracleClient(c), "oracle"
    else:
        shared = client_for(name)

        def mk(c):
            return shared

    todo = [c for c in cmds if c["id"] not in done]
    print(f"{name}: {len(todo)} test commands to run")
    t0 = time.time()
    with out.open("a") as f, ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(lambda c: loop.solve(*mk(c), c), c) for c in todo]
        for fut in as_completed(futs):
            tr = fut.result()
            f.write(json.dumps({**tr, "verify": verify.verify(tr)}) + "\n")
    print(f"{name}: done in {time.time() - t0:.0f} s -> {out.relative_to(ROOT)}")


def report() -> None:
    rows = []
    for p in sorted(DATA.glob("eval_*.jsonl")):
        name = p.stem.removeprefix("eval_")
        if name == "oracle":
            continue  # pipeline self-check, not a model
        rows.append(score([json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()], name))
    METRICS.mkdir(exist_ok=True)
    (METRICS / "results.json").write_text(json.dumps({"generated": time.time(), "models": rows}, indent=2) + "\n")
    for r in rows:
        print(json.dumps(r))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", required=True, choices=["super", "nano-tf", "nano", "nano-lora", "oracle"])
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--limit", type=int, default=0)
    sub.add_parser("report")
    a = ap.parse_args()
    if a.cmd == "run":
        run(a.model, a.workers, a.limit)
    else:
        report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
