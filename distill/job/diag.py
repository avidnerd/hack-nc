"""Why does LoRA on Nano 9B v2 diverge? (grad norm 1e8 at step 10, 1e13 later;
eval loss 0.71 -> 1.79 over two epochs, run lora-1024-1328.)

    python diag.py --data /data/distill/data

On one fixed batch of 4 training turns:
  1. loss in eval mode vs train mode (no grad): a gap means the training-mode
     kernel path computes something different from the inference path;
  2. per-module gradient norms after one backward, largest first;
  3. 15 optimizer steps overfitting that batch, for each setup:
       A  as trained (bf16, gradient checkpointing, config use_cache)
       B  A with use_cache=False
       C  B without gradient checkpointing
       D  B with fp32 weights
     A healthy setup drives the loss down; a broken one does not.
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


def build(dtype, use_cache: bool | None, gc: bool):
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM

    m = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=dtype, trust_remote_code=True, device_map="cuda")
    if use_cache is not None:
        m.config.use_cache = use_cache
    if gc:
        m.gradient_checkpointing_enable()
        m.enable_input_require_grads()
    return get_peft_model(m, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.0, target_modules=TARGETS, task_type="CAUSAL_LM"))


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

    setups = {
        "A_as_trained": (torch.bfloat16, None, True),
        "B_no_cache": (torch.bfloat16, False, True),
        "C_no_cache_no_gc": (torch.bfloat16, False, False),
        "D_fp32_no_cache": (torch.float32, False, True),
    }
    for name, (dtype, use_cache, gc) in setups.items():
        m = None
        try:
            m = build(dtype, use_cache, gc)
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
            for _ in range(15):
                loss = m(**b).loss
                loss.backward()
                gn = torch.nn.utils.clip_grad_norm_([p for p in m.parameters() if p.requires_grad], 1.0).item()
                opt.step()
                opt.zero_grad()
                traj.append((round(loss.item(), 4), float(f"{gn:.3g}")))
            out(test="overfit_15", setup=name, loss_gradnorm=traj)
        except Exception as e:  # one setup failing (e.g. OOM) must not hide the others
            out(test="error", setup=name, error=f"{type(e).__name__}: {e}"[:400])
        finally:
            del m
            torch.cuda.empty_cache()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
