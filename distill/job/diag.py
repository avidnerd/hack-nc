"""Why does LoRA on Nano 9B v2 diverge? (grad norm 1e8 at step 10, 1e13 later;
eval loss 0.71 -> 1.79 over two epochs, run lora-1024-1328.)

    python diag.py --data /data/distill/data

On one fixed batch of 4 training turns:
  1. loss in eval mode vs train mode (no grad): a gap means the training-mode
     kernel path computes something different from the inference path;
  2. per-module gradient norms after one backward, largest first;
  3. 30 optimizer steps overfitting that batch, for each setup.
     A healthy setup drives the loss down; a broken one does not.

Run 1 (2026-10-25) found train == eval loss, finite grads, and up_proj LoRA B in
layers 1/3/5 at ~2e7 grad norm vs <=1e3 elsewhere; nothing learned in 15 steps
with bf16 or fp32, with or without use_cache. Run 2 compares target sets:
Prints one JSON line per result.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train import BASE, TARGETS, load, tokenize  # noqa: E402


def batch(tok, data: Path, n: int = 4) -> dict:
    exs = load(data / "sft_train.jsonl")[:20]
    turns = [t for ex in exs for t in tokenize(tok, ex, 4096)][:n]
    width = max(len(t["input_ids"]) for t in turns)
    pad = tok.pad_token_id
    ids = torch.tensor([t["input_ids"] + [pad] * (width - len(t["input_ids"])) for t in turns])
    lab = torch.tensor([t["labels"] + [-100] * (width - len(t["labels"])) for t in turns])
    att = torch.tensor([t["attention_mask"] + [0] * (width - len(t["attention_mask"])) for t in turns])
    return {"input_ids": ids.cuda(), "labels": lab.cuda(), "attention_mask": att.cuda()}


def build(dtype, use_cache: bool | None, gc: bool, targets=TARGETS, layers=None):
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM

    m = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=dtype, trust_remote_code=True, device_map="cuda")
    if use_cache is not None:
        m.config.use_cache = use_cache
    if gc:
        m.gradient_checkpointing_enable()
        m.enable_input_require_grads()
    if layers is not None:
        # Only modules in these layer indices (regex over the full module name).
        alt = "|".join(targets)
        lay = "|".join(str(i) for i in layers)
        targets = rf".*\.layers\.({lay})\.mixer\.({alt})$"
    return get_peft_model(m, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.0, target_modules=targets, task_type="CAUSAL_LM"))


def out(**kw) -> None:
    print(json.dumps(kw), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    a = ap.parse_args()

    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
    tok.pad_token = tok.pad_token or tok.eos_token
    b = batch(tok, a.data)
    out(test="batch", shape=list(b["input_ids"].shape), target_tokens=int((b["labels"] != -100).sum()))

    attn = ["q_proj", "k_proj", "v_proj", "o_proj"]
    # name: (targets, layers or None, clip or None)
    setups = {
        "E_attention_only": (attn, None, 1.0),
        "F_all_targets_no_clip": (TARGETS, None, None),
        "G_attn_up_from_layer_8": (attn + ["up_proj"], list(range(8, 56)), 1.0),
        "H_attn_mamba": (attn + ["in_proj", "out_proj"], None, 1.0),
    }
    for name, (targets, layers, clip) in setups.items():
        m = None
        try:
            m = build(torch.bfloat16, False, True, targets, layers)
            with torch.no_grad():
                m.eval()
                le = m(**b).loss.item()
                m.train()
                lt = m(**b).loss.item()
            out(test="eval_vs_train_loss", setup=name, eval=round(le, 4), train=round(lt, 4))

            m.train()
            loss = m(**b).loss
            loss.backward()
            norms = sorted(
                ((n, p.grad.float().norm().item()) for n, p in m.named_parameters() if p.grad is not None),
                key=lambda x: -x[1] if x[1] == x[1] else float("-inf"),
            )
            bad = sum(1 for _, v in norms if not torch.isfinite(torch.tensor(v)))
            total = sum(v * v for _, v in norms if v == v) ** 0.5
            out(test="grad_norms", setup=name, total=total, non_finite=bad, top=[(n.replace("base_model.model.", ""), round(v, 3)) for n, v in norms[:6]])
            m.zero_grad()

            opt = torch.optim.AdamW([p for p in m.parameters() if p.requires_grad], lr=1e-4)
            traj = []
            for _ in range(30):
                loss = m(**b).loss
                loss.backward()
                params = [p for p in m.parameters() if p.requires_grad]
                gn = torch.nn.utils.clip_grad_norm_(params, clip if clip else float("inf")).item()
                opt.step()
                opt.zero_grad()
                traj.append((round(loss.item(), 4), float(f"{gn:.3g}")))
            out(test="overfit_30", setup=name, start=traj[0][0], end=traj[-1][0], loss_gradnorm=traj[::3])
        except Exception as e:  # one setup failing (e.g. OOM) must not hide the others
            out(test="error", setup=name, error=f"{type(e).__name__}: {e}"[:400])
        finally:
            del m
            torch.cuda.empty_cache()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
