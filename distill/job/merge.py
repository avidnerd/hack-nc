"""Fold the LoRA into Nano 9B v2 so vLLM can serve it without --enable-lora
(vLLM 0.11's LoRA manager fails on NemotronH; docs/DECISIONS.md 2026-10-25).

    python merge.py --adapter /data/distill/runs/<run>/scrub-lora --out /root/merged
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import torch
from huggingface_hub import snapshot_download
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = "nvidia/NVIDIA-Nemotron-Nano-9B-v2"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()

    base_dir = Path(snapshot_download(BASE))
    model = AutoModelForCausalLM.from_pretrained(base_dir, torch_dtype=torch.bfloat16, trust_remote_code=True)
    model = PeftModel.from_pretrained(model, str(a.adapter)).merge_and_unload()
    model.save_pretrained(a.out, safe_serialization=True)
    AutoTokenizer.from_pretrained(base_dir, trust_remote_code=True).save_pretrained(a.out)
    # The remote-code modeling files and the tool-call parser plugin.
    for f in base_dir.glob("*.py"):
        shutil.copyfile(f, a.out / f.name)
    print("merged ->", a.out, sorted(p.name for p in a.out.iterdir()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
