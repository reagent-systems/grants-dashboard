#!/usr/bin/env python
"""
Training entrypoint for the ML research agent's <1B fine-tuning runs on RunPod.

ALL configuration comes from environment variables (the RunPod broker injects
these via the pod `env` list; see SOP-02). No CLI args, no hardcoded secrets.

Required env:
  BASE_MODEL    HF model id, <1B recommended (e.g. "EleutherAI/pythia-410m")
  DATASET       HF dataset id (e.g. "tatsu-lab/alpaca")
  OUTPUT_REPO   HF repo to push to (e.g. "myorg/pythia410m-run1")
  HF_TOKEN      HF token with write access (injected by broker as a pod env secret)

Optional env (sane defaults; the agent overrides via the DoE / experiment design):
  METHOD        full | lora | qlora           (default: full)
  TEXT_FIELD    dataset column with text       (default: auto-detect)
  MAX_STEPS     cap steps (proxy runs)         (default: unset -> use EPOCHS)
  EPOCHS        num train epochs               (default: 3)
  LR            learning rate                  (default: 2e-4)
  BATCH_SIZE    per-device train batch size    (default: 8)
  GRAD_ACCUM    gradient accumulation steps    (default: 4)
  MAX_SEQ_LEN   max sequence length            (default: 1024)
  LORA_R        LoRA rank (lora/qlora)         (default: 16)
  EVAL_RATIO    held-out fraction for eval     (default: 0.05)
  DATA_SUBSET   fraction of train to use       (default: 1.0; use <1 for proxy)
  SEED          random seed                    (default: 42)
  CHECKPOINT_STEPS  push a checkpoint every N steps (default: 0 = only at end)

Exit code 0 on success (model + metrics pushed to OUTPUT_REPO). Non-zero on
failure. Metrics are written to eval_results.json and also printed as a single
line prefixed "RESULT_JSON:" so the pod log can be scraped if needed.
"""
import json
import math
import os
import sys
import time

import torch
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
)
from trl import SFTTrainer, SFTConfig
from huggingface_hub import HfApi, login


def env(key, default=None, cast=str):
    v = os.environ.get(key)
    if v is None or v == "":
        return default
    if cast is bool:
        return v.lower() in ("1", "true", "yes")
    return cast(v)


def die(msg, code=1):
    print(f"FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def detect_text_field(ds):
    """Pick a text column; prefer common instruction/text names."""
    cols = ds.column_names
    for c in ("text", "content", "prompt", "instruction"):
        if c in cols:
            return c
    # Fall back to the first string column.
    for c in cols:
        if isinstance(ds[0][c], str):
            return c
    die(f"could not find a text field in dataset columns: {cols}")


def build_text(example, field, ds_cols):
    """Format a row into a single training string.

    If the dataset looks instruction-style (instruction/input/output), build a
    simple prompt-completion template; else use the raw text field.
    """
    if {"instruction", "output"}.issubset(ds_cols):
        instr = example.get("instruction", "") or ""
        inp = example.get("input", "") or ""
        out = example.get("output", "") or ""
        if inp:
            return f"### Instruction:\n{instr}\n\n### Input:\n{inp}\n\n### Response:\n{out}"
        return f"### Instruction:\n{instr}\n\n### Response:\n{out}"
    return example[field]


def main():
    t0 = time.time()

    base_model = env("BASE_MODEL") or die("BASE_MODEL is required")
    dataset_id = env("DATASET") or die("DATASET is required")
    output_repo = env("OUTPUT_REPO") or die("OUTPUT_REPO is required")
    hf_token = env("HF_TOKEN") or die("HF_TOKEN is required (write access)")

    method = (env("METHOD", "full")).lower()
    epochs = env("EPOCHS", 3, int)
    max_steps = env("MAX_STEPS", -1, int)
    lr = env("LR", 2e-4, float)
    batch_size = env("BATCH_SIZE", 8, int)
    grad_accum = env("GRAD_ACCUM", 4, int)
    max_seq_len = env("MAX_SEQ_LEN", 1024, int)
    lora_r = env("LORA_R", 16, int)
    eval_ratio = env("EVAL_RATIO", 0.05, float)
    data_subset = env("DATA_SUBSET", 1.0, float)
    seed = env("SEED", 42, int)
    ckpt_steps = env("CHECKPOINT_STEPS", 0, int)

    if method not in ("full", "lora", "qlora"):
        die(f"METHOD must be full|lora|qlora, got {method}")

    print(f"[cfg] base={base_model} dataset={dataset_id} method={method} "
          f"epochs={epochs} max_steps={max_steps} lr={lr} bs={batch_size} "
          f"ga={grad_accum} seq={max_seq_len} subset={data_subset} seed={seed}",
          flush=True)

    login(token=hf_token)
    torch.manual_seed(seed)

    # ---- Load + split data ----
    raw = load_dataset(dataset_id, split="train")
    if data_subset < 1.0:
        n = max(1, int(len(raw) * data_subset))
        raw = raw.shuffle(seed=seed).select(range(n))
    ds_cols = raw.column_names
    text_field = env("TEXT_FIELD") or detect_text_field(raw)
    print(f"[data] rows={len(raw)} text_field={text_field}", flush=True)

    split = raw.train_test_split(test_size=eval_ratio, seed=seed)
    train_ds, eval_ds = split["train"], split["test"]

    def fmt(ex):
        return {"text": build_text(ex, text_field, ds_cols)}

    train_ds = train_ds.map(fmt, remove_columns=ds_cols)
    eval_ds = eval_ds.map(fmt, remove_columns=ds_cols)

    # ---- Tokenizer ----
    tok = AutoTokenizer.from_pretrained(base_model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # ---- Model (method-dependent) ----
    quant_cfg = None
    if method == "qlora":
        quant_cfg = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        quantization_config=quant_cfg,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )

    peft_cfg = None
    if method in ("lora", "qlora"):
        from peft import LoraConfig
        peft_cfg = LoraConfig(
            r=lora_r,
            lora_alpha=lora_r * 2,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
        )

    # ---- Training config ----
    out_dir = "/app/out"
    sft_cfg = SFTConfig(
        output_dir=out_dir,
        num_train_epochs=epochs,
        max_steps=max_steps,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        learning_rate=lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=max(10, (max_steps if max_steps > 0 else 200) // 5),
        save_steps=ckpt_steps if ckpt_steps > 0 else 10_000_000,
        save_total_limit=2,
        bf16=torch.cuda.is_available(),
        max_seq_length=max_seq_len,
        seed=seed,
        report_to=[],
        push_to_hub=ckpt_steps > 0,          # periodic checkpoints survive a $0 stop
        hub_model_id=output_repo if ckpt_steps > 0 else None,
        hub_token=hf_token if ckpt_steps > 0 else None,
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_cfg,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        peft_config=peft_cfg,
        processing_class=tok,
    )

    # ---- Baseline eval (before training) for honest deltas ----
    try:
        pre = trainer.evaluate()
        pre_loss = pre.get("eval_loss")
        print(f"[eval] pre-train eval_loss={pre_loss}", flush=True)
    except Exception as e:  # noqa
        pre_loss = None
        print(f"[eval] pre-train eval skipped: {e}", flush=True)

    # ---- Train ----
    trainer.train()

    # ---- Final eval ----
    post = trainer.evaluate()
    post_loss = post.get("eval_loss")
    try:
        perplexity = math.exp(post_loss) if post_loss is not None else None
    except OverflowError:
        perplexity = float("inf")

    metrics = {
        "base_model": base_model,
        "dataset": dataset_id,
        "method": method,
        "epochs": epochs,
        "max_steps": max_steps,
        "lr": lr,
        "batch_size": batch_size,
        "grad_accum": grad_accum,
        "seed": seed,
        "data_subset": data_subset,
        "train_rows": len(train_ds),
        "eval_rows": len(eval_ds),
        "pre_train_eval_loss": pre_loss,
        "eval_loss": post_loss,
        "eval_perplexity": perplexity,
        "wall_seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(out_dir, "eval_results.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    print("RESULT_JSON:" + json.dumps(metrics), flush=True)

    # ---- Push final model + tokenizer + metrics to HF ----
    trainer.save_model(out_dir)
    tok.save_pretrained(out_dir)
    api = HfApi(token=hf_token)
    api.create_repo(repo_id=output_repo, exist_ok=True, private=True)
    api.upload_folder(folder_path=out_dir, repo_id=output_repo, repo_type="model")
    print(f"[done] pushed to https://huggingface.co/{output_repo}", flush=True)

    sys.exit(0)


if __name__ == "__main__":
    main()
