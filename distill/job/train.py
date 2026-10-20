"""LoRA fine-tune of Nemotron Nano 9B v2 on the verified traces (CLAUDE.md 5.4).
Runs as the `distill-nano` Nebius Serverless Job (see distill/job/README.md).

    python train.py --data /data --out /out [--epochs 2] [--dry-run]

Hyperparameters are the brief's: r 16, alpha 32, lr 1e-4, 2 epochs, max seq
4096. Loss is on assistant turns only (the tool calls and the final text),
not on the system prompt, state or tool results the engine wrote.

DECISION: LoRA targets attention and MLP projections only (q/k/v/o_proj,
up/down_proj), not the Mamba in_proj/out_proj, so vLLM can serve the adapter
without merging (docs/DECISIONS.md, 2026-10-19).

--dry-run loads only the tokenizer, renders every example with the chat
template and reports token lengths and the share of tokens trained on. It
runs on a laptop and is how the data format is checked before paying for GPU.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

BASE = "nvidia/NVIDIA-Nemotron-Nano-9B-v2"
TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj"]


def load(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text().splitlines() if ln.strip()]


def to_template_messages(msgs: list[dict]) -> list[dict]:
    """OpenAI-format tool calls carry arguments as a JSON string; HF chat
    templates expect a dict. The system prompt gets /no_think: the agent runs
    without a reasoning trace at runtime (latency), so it trains without one."""
    out = []
    for i, m in enumerate(msgs):
        m = dict(m)
        if i == 0 and m["role"] == "system":
            m["content"] = m["content"].rstrip() + "\n/no_think"
        if m.get("tool_calls"):
            m["tool_calls"] = [
                {"type": "function", "function": {"name": tc["function"]["name"], "arguments": json.loads(tc["function"]["arguments"] or "{}")}}
                for tc in m["tool_calls"]
            ]
            m["content"] = m.get("content") or ""
        out.append(m)
    return out


def target_text(m: dict) -> str:
    """An assistant turn exactly as the chat template renders it after the
    generation prompt: content, then <TOOLCALL>[...]</TOOLCALL>, then the end
    marker. Arguments are dumped the way the template's tojson filter does."""
    content = (m.get("content") or "").strip()
    if m.get("tool_calls"):
        calls = ", ".join(
            '{"name": "%s", "arguments": %s}' % (tc["function"]["name"], json.dumps(tc["function"]["arguments"], ensure_ascii=False))
            for tc in m["tool_calls"]
        )
        content = (content + "\n\n" if content else "") + f"<TOOLCALL>[{calls}]</TOOLCALL>"
    return content + "\n<SPECIAL_12>\n"


def tokenize(tok, ex: dict, max_len: int) -> list[dict]:
    """One training example per assistant turn: the prompt is the history up
    to that turn rendered with add_generation_prompt (exactly what vLLM feeds
    the model at runtime, including the empty <think></think>), the target is
    the turn itself. Loss is on the target only.

    DECISION: per-turn examples rather than one masked sequence. Nano's chat
    template renders earlier assistant turns differently from the generation
    prompt (no think block), so a single sequence would train on a format the
    model never sees when serving."""
    msgs = to_template_messages(ex["messages"])
    out = []
    for i, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        prompt = tok.apply_chat_template(msgs[:i], tools=ex["tools"], tokenize=False, add_generation_prompt=True)
        p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
        t_ids = tok(target_text(m), add_special_tokens=False)["input_ids"]
        ids = (p_ids + t_ids)[:max_len]
        labels = ([-100] * len(p_ids) + t_ids)[:max_len]
        out.append({"input_ids": ids, "labels": labels, "attention_mask": [1] * len(ids), "len": len(p_ids) + len(t_ids)})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--max-len", type=int, default=4096)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
    train = [x for ex in load(a.data / "sft_train.jsonl") for x in tokenize(tok, ex, a.max_len)]
    val = [x for ex in load(a.data / "sft_val.jsonl") for x in tokenize(tok, ex, a.max_len)]
    lens = sorted(x["len"] for x in train)
    trained = sum(sum(1 for t in x["labels"] if t != -100) for x in train)
    stats = {
        "train_turns": len(train),
        "val_turns": len(val),
        "tokens_median": lens[len(lens) // 2] if lens else 0,
        "tokens_max": lens[-1] if lens else 0,
        "truncated": sum(1 for x in train if x["len"] > a.max_len),
        "trained_token_share": round(trained / max(sum(lens), 1), 3),
    }
    print(json.dumps(stats))
    if a.dry_run:
        return 0

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, DataCollatorForSeq2Seq, Trainer, TrainingArguments

    model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, trust_remote_code=True, device_map="cuda")
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules=TARGETS, task_type="CAUSAL_LM"))
    model.print_trainable_parameters()

    strip = lambda xs: [{k: v for k, v in x.items() if k != "len"} for x in xs]  # noqa: E731
    args = TrainingArguments(
        output_dir=str(a.out / "ckpt"),
        num_train_epochs=a.epochs,
        learning_rate=a.lr,
        per_device_train_batch_size=a.batch,
        gradient_accumulation_steps=a.grad_accum,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=50,
        save_strategy="no",
        report_to=[],
        seed=20261020,
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=strip(train),
        eval_dataset=strip(val),
        data_collator=DataCollatorForSeq2Seq(tok, padding=True, label_pad_token_id=-100),
    )
    t0 = time.time()
    trainer.train()
    wall = time.time() - t0

    adapter = a.out / "scrub-lora"
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    log = {
        **stats,
        "wall_s": round(wall),
        "gpu": torch.cuda.get_device_name(0),
        "hparams": {"r": 16, "alpha": 32, "lr": a.lr, "epochs": a.epochs, "max_len": a.max_len, "targets": TARGETS},
        "history": trainer.state.log_history,
    }
    (a.out / "train_log.json").write_text(json.dumps(log, indent=2))
    print(json.dumps({k: v for k, v in log.items() if k != "history"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
