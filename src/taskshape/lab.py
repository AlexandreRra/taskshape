"""Lab: labelled dataset, offline evaluation, local fine-tuning and gated adoption of a Laya checkpoint.

Everything here is offline. `dataset`, `compare` and `adopt` need only the standard library; `budget`,
`eval` and `finetune` import torch and laya lazily (install the `laya` extra).
"""
from __future__ import annotations
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import sys
import time

from .router import DEFAULT_HEAD_MAX_LEN, questions_for, state_for
from .rubric import classify, soft_target
from .shapes import SHAPES, shapes_for

OPTION_TOKEN_CAP = 48
REQUIRED_SPLITS = ("heldout",)


# ----------------------------------------------------------------------------- dataset

def stable_fraction(identity: str, seed: int) -> float:
    digest = hashlib.sha256(("%s:%d" % (identity, seed)).encode()).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


def read_jsonl(path) -> list[dict]:
    with open(path, encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_jsonl(path, rows) -> None:
    with open(path, "w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_row(identity: str, brief: dict, head_max_len: int) -> dict | None:
    phase = brief.get("phase", "work")
    options = shapes_for(phase)
    shape = brief.get("shape") or classify(brief["task"], phase, brief.get("role"))
    if shape not in options:
        return None
    questions = questions_for(phase, head_max_len)
    return {"id": identity, "template": brief.get("template"), "labelled_by": "human" if brief.get("shape") else "rubric",
            "state": state_for(brief["task"], phase, brief.get("context")), "questions": questions,
            "expected": {"shape": shape}, "gold": {"shape": {"probabilities": soft_target(shape, options)}}}


def build_dataset(briefs_path, out, seed: int = 20261005, heldout_fraction: float = 0.2,
                  head_max_len: int = DEFAULT_HEAD_MAX_LEN) -> dict:
    """Rows: {"task", "phase"?, "shape"?, "role"?, "template"?}. Held-out by template when present, else by text hash."""
    briefs = read_jsonl(briefs_path)
    rows, skipped, seen = [], 0, set()
    for index, brief in enumerate(briefs):
        if not isinstance(brief, dict) or not isinstance(brief.get("task"), str) or not brief["task"].strip():
            skipped += 1
            continue
        if brief["task"] in seen:
            skipped += 1
            continue
        seen.add(brief["task"])
        row = make_row("b-%05d" % index, brief, head_max_len)
        if row:
            rows.append(row)
        else:
            skipped += 1
    templates = sorted({row["template"] for row in rows if row["template"] is not None})
    heldout_templates = {t for t in templates if stable_fraction("template:%s" % t, seed) < heldout_fraction}
    train, heldout = [], []
    for row in rows:
        key = row["template"] if row["template"] is not None else None
        is_heldout = (key in heldout_templates) if key is not None else stable_fraction(row["state"]["task"], seed) < heldout_fraction
        (heldout if is_heldout else train).append(row)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    train_texts = {row["state"]["task"] for row in train}
    meta = {"version": 1, "created_at": time.time(), "seed": seed, "heldout_fraction": heldout_fraction, "head_max_len": head_max_len,
            "briefs": len(briefs), "skipped": skipped, "templates": len(templates), "heldout_templates": sorted(heldout_templates),
            "heldout_text_leaks": [row["id"] for row in heldout if row["state"]["task"] in train_texts], "files": {}}
    for name, subset in (("all", rows), ("train", train), ("heldout", heldout)):
        path = out / (name + ".jsonl")
        write_jsonl(path, subset)
        meta["files"][name] = {"path": str(path), "sha256": sha256_file(path), "rows": len(subset),
                               "shapes": dict(collections.Counter(row["expected"]["shape"] for row in subset)),
                               "labelled_by": dict(collections.Counter(row["labelled_by"] for row in subset))}
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


# ----------------------------------------------------------------------------- offline ML helpers

def deny_network() -> None:
    import socket

    def denied(*args, **kwargs):
        raise RuntimeError("Network disabled in the taskshape lab")
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    os.environ.update({"HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TRANSFORMERS_OFFLINE": "1",
                       "TOKENIZERS_PARALLELISM": "false"})


def resolve_checkpoint(checkpoint) -> Path:
    path = Path(checkpoint)
    if not (path / "rl_agent_config.json").is_file() or not (path / "model.safetensors").is_file():
        raise ValueError("Checkpoint directory lacks rl_agent_config.json or model.safetensors: %s" % path)
    return path


def pick_device(requested: str):
    import torch
    if requested == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")
    return torch.device(requested)


def ece(confidences, correct, bins: int = 10):
    if not confidences:
        return None
    total, error = len(confidences), 0.0
    for index in range(bins):
        low, high = index / bins, (index + 1) / bins
        members = [i for i, c in enumerate(confidences) if (c > low or (index == 0 and c >= low)) and c <= high]
        if members:
            error += len(members) / total * abs(sum(confidences[i] for i in members) / len(members)
                                                - sum(correct[i] for i in members) / len(members))
    return round(error, 4)


def metrics_for(results: list[dict]) -> dict:
    confidences = [r["answer_confidence"] for r in results]
    correct = [1.0 if r["correct"] else 0.0 for r in results]
    confusion = collections.Counter((r["expected"], r["choice"]) for r in results)
    return {"n": len(results), "accuracy": round(sum(correct) / len(results), 4) if results else None,
            "mean_answer_confidence": round(sum(confidences) / len(results), 4) if results else None,
            "ece": ece(confidences, correct),
            "confusion": {"%s->%s" % pair: count for pair, count in sorted(confusion.items())}}


def evaluate(checkpoint, datasets, out, device: str = "auto", head_max_len: int = DEFAULT_HEAD_MAX_LEN) -> dict:
    deny_network()
    import torch
    from laya import Agent
    checkpoint = resolve_checkpoint(checkpoint)
    target = pick_device(device)
    torch.manual_seed(0)
    report = {"version": 1, "created_at": time.time(), "checkpoint": str(checkpoint),
              "checkpoint_sha256": sha256_file(checkpoint / "model.safetensors"), "device": str(target), "splits": {}}
    with Agent(str(checkpoint), device=str(target)) as agent:
        report["laya_config"] = {k: agent.cfg.get(k) for k in ("model_name", "max_len", "head_max_len", "temperature",
                                                                "temperature_by_options", "fine_tuned", "taskshape")}
        for dataset in datasets:
            rows, results, started = read_jsonl(dataset), [], time.monotonic()
            for row in rows:
                answer = agent.predict(row["state"], row["questions"], head_max_len=head_max_len)["answers"]["shape"]
                expected = row["expected"]["shape"]
                results.append({"id": row["id"], "expected": expected, "choice": answer["choice"], "correct": answer["choice"] == expected,
                                "answer_confidence": float(answer["answer_confidence"]), "confidence": float(answer["confidence"]),
                                "probabilities": {k: round(float(v), 4) for k, v in answer["probabilities"].items()}})
            report["splits"][Path(dataset).stem] = {"dataset": str(dataset), "dataset_sha256": sha256_file(dataset), "rows": len(rows),
                                                    "seconds": round(time.monotonic() - started, 2), "metrics": metrics_for(results),
                                                    "results": results}
    Path(out).write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report


def check_budget(checkpoint, head_max_len: int = DEFAULT_HEAD_MAX_LEN) -> dict:
    deny_network()
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_head, state_room
    checkpoint = resolve_checkpoint(checkpoint)
    _fix_tokenizer_config(str(checkpoint))
    tokenizer = AutoTokenizer.from_pretrained(str(checkpoint / "tokenizer"))
    cfg = json.loads((checkpoint / "rl_agent_config.json").read_text(encoding="utf-8"))
    report = {"head_max_len": head_max_len, "max_len": cfg.get("max_len", 1024), "criteria": {}, "questions": {}}
    for name, shape in SHAPES.items():
        count = len(tokenizer(" %s: %s" % (name, shape["criteria"]), add_special_tokens=False)["input_ids"])
        report["criteria"][name] = {"tokens": count, "within_cap": count <= OPTION_TOKEN_CAP}
    for phase in ("work", "review"):
        question = questions_for(phase)["shape"]
        q = {"t": "choice", "ins": question["instructions"], "crit": question["criteria"]}
        ids, markers, stats = build_head(tokenizer, q, head_max_len)
        full = len(tokenizer("choice question: " + question["instructions"], add_special_tokens=False)["input_ids"])
        report["questions"][phase] = {"options": stats["options"], "options_distinct": stats["options_distinct"],
                                      "head_tokens": len(ids), "instruction_tokens_kept": markers[0] - 2 if markers else 0,
                                      "instruction_tokens_full": full,
                                      "state_room_tokens": state_room(tokenizer, q, report["max_len"], head_max_len)}
    report["all_criteria_within_cap"] = all(c["within_cap"] for c in report["criteria"].values())
    report["all_options_distinct"] = all(q["options"] == q["options_distinct"] for q in report["questions"].values())
    report["all_instructions_whole"] = all(q["instruction_tokens_kept"] >= q["instruction_tokens_full"] for q in report["questions"].values())
    return report


# ----------------------------------------------------------------------------- fine-tuning (RLCD loop as upstream Laya)

def build_items(tokenizer, cfg, rows):
    from laya.common import QTYPES, build_sequence, render_options
    items, skipped = [], 0
    for row in rows:
        question = row["questions"]["shape"]
        keys = list(question["criteria"])
        target = [float(row["gold"]["shape"]["probabilities"].get(k, 0.0)) for k in keys]
        total = sum(target)
        target = [v / total for v in target] if total > 0 else [1.0 / len(keys)] * len(keys)
        q = {"t": "choice", "ins": question["instructions"], "crit": question["criteria"]}
        ids, markers = build_sequence(tokenizer, row["state"], q, cfg["max_len"], cfg["head_max_len"])
        if len(markers) != len(render_options(q)):
            skipped += 1
            continue
        items.append({"ids": ids, "markers": markers, "qtype": QTYPES["choice"], "target": target})
    return items, skipped


def collate(items, pad_id):
    import torch
    batch, length = len(items), max(len(i["ids"]) for i in items)
    kmax = max(len(i["markers"]) for i in items)
    ids = torch.full((batch, length), pad_id, dtype=torch.long)
    attention = torch.zeros((batch, length), dtype=torch.long)
    positions = torch.zeros((batch, kmax), dtype=torch.long)
    mask = torch.zeros((batch, kmax), dtype=torch.bool)
    target = torch.zeros((batch, kmax), dtype=torch.float32)
    for index, item in enumerate(items):
        n, k = len(item["ids"]), len(item["markers"])
        ids[index, :n] = torch.tensor(item["ids"], dtype=torch.long)
        attention[index, :n] = 1
        positions[index, :k] = torch.tensor(item["markers"], dtype=torch.long)
        mask[index, :k] = True
        target[index, :len(item["target"])] = torch.tensor(item["target"], dtype=torch.float32)
    return ids, attention, positions, mask, target, torch.tensor([i["qtype"] for i in items], dtype=torch.long)


def fit_temperature(samples, minimum: int = 8):
    """Temperature scaling against the gold label (one-hot), clamped to Laya's accepted range; None when too few."""
    import torch
    if len(samples) < minimum:
        return None
    kmax = max(len(logits) for logits, _ in samples)
    logits = torch.full((len(samples), kmax), -1e4)
    targets = torch.zeros((len(samples), kmax))
    for index, (values, target) in enumerate(samples):
        logits[index, :len(values)] = torch.as_tensor(values, dtype=torch.float32)
        targets[index, max(range(len(target)), key=lambda i: target[i])] = 1.0
    log_temperature = torch.zeros(1, requires_grad=True)
    optimizer = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=100)

    def closure():
        optimizer.zero_grad()
        loss = -(targets * torch.log_softmax(logits / log_temperature.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss
    optimizer.step(closure)
    return float(torch.clamp(log_temperature.exp(), 0.5, 5.0).item())


def set_trainable(model, train_top_layers: int) -> dict:
    total = len(model.encoder.layers)
    trainable = frozen = 0
    for name, parameter in model.named_parameters():
        match = re.match(r"encoder\.layers\.(\d+)\.", name)
        if name.startswith("act_head.") or name.startswith("encoder.embeddings."):
            keep = False
        elif match:
            keep = int(match.group(1)) >= total - train_top_layers
        else:
            keep = True
        parameter.requires_grad_(keep)
        trainable += parameter.numel() if keep else 0
        frozen += 0 if keep else parameter.numel()
    return {"encoder_layers": total, "trainable_parameters": trainable, "frozen_parameters": frozen}


def finetune(base, train_path, out_dir, device: str = "auto", epochs: int = 4, micro_batch: int = 2, grad_accum: int = 8,
             train_top_layers: int = 8, calib_fraction: float = 0.15, seed: int = 20261005, lr_encoder: float = 2.5e-5,
             lr_head: float = 1e-4, head_max_len: int = DEFAULT_HEAD_MAX_LEN) -> dict:
    deny_network()
    import torch
    from safetensors.torch import load_file, save_file
    from transformers import AutoTokenizer
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model, proper_reward, temp_bucket
    base = resolve_checkpoint(base)
    target_device = pick_device(device)
    out_dir = Path(out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        raise ValueError("Output directory must be empty: %s" % out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    random.seed(seed)
    torch.manual_seed(seed)
    cfg = json.loads((base / "rl_agent_config.json").read_text(encoding="utf-8"))
    base_cfg = dict(cfg)
    cfg.update({"max_len": 1024, "head_max_len": head_max_len, "max_tokens_per_batch": 2048, "gradient_checkpointing": True})
    _fix_tokenizer_config(str(base))
    tokenizer = AutoTokenizer.from_pretrained(str(base / "tokenizer"))
    rows = read_jsonl(train_path)
    order = list(range(len(rows)))
    random.Random(seed).shuffle(order)
    n_calib = max(4, int(len(rows) * calib_fraction))
    calib_rows = [rows[i] for i in sorted(order[:n_calib])]
    train_rows = [rows[i] for i in sorted(order[n_calib:])]
    train_items, skipped_train = build_items(tokenizer, cfg, train_rows)
    calib_items, skipped_calib = build_items(tokenizer, cfg, calib_rows)
    if len(train_items) < 8:
        raise ValueError("Too few training items: %d" % len(train_items))
    model = build_model(cfg, encoder_dir=str(base / "encoder"), pretrained=False)
    model.load_state_dict(load_file(str(base / "model.safetensors")), strict=True)
    model.float()
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    freeze_info = set_trainable(model, train_top_layers)
    model.to(target_device).train()
    encoder_params = [p for n, p in model.named_parameters() if p.requires_grad and n.startswith("encoder.")]
    head_params = [p for n, p in model.named_parameters() if p.requires_grad and not n.startswith("encoder.")]
    optimizer = torch.optim.AdamW([{"params": encoder_params, "lr": lr_encoder}, {"params": head_params, "lr": lr_head}], weight_decay=0.01)
    updates = max(1, math.ceil(len(train_items) / micro_batch / grad_accum) * epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=updates, eta_min=1e-6)
    use_autocast = target_device.type == "cuda"
    log = {"device": str(target_device), "base_checkpoint": str(base), "base_sha256": sha256_file(base / "model.safetensors"),
           "train_dataset": str(train_path), "train_sha256": sha256_file(train_path), "rows": len(rows), "train_rows": len(train_rows),
           "calib_rows": len(calib_rows), "train_items": len(train_items), "calib_items": len(calib_items),
           "items_skipped": skipped_train + skipped_calib, "epochs": epochs, "micro_batch": micro_batch, "grad_accum": grad_accum,
           "updates": updates, "train_top_layers": train_top_layers, "seed": seed, **freeze_info, "epoch_loss": [], "started_at": time.time()}
    for epoch in range(epochs):
        random.Random(seed + epoch).shuffle(train_items)
        optimizer.zero_grad(set_to_none=True)
        total_loss, n_batches = 0.0, 0
        sigma = 0.4 + (0.1 - 0.4) * epoch / max(1, epochs - 1)
        for start in range(0, len(train_items), micro_batch):
            chunk = train_items[start:start + micro_batch]
            ids, attention, positions, mask, target, qtype = (t.to(target_device) for t in collate(chunk, tokenizer.pad_token_id))
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=use_autocast):
                logits, activation = model(ids, attention, positions, mask, qtype)
            logits = logits.float()
            k = mask.sum(-1, keepdim=True).float()
            eps = torch.randn((4,) + logits.shape, device=target_device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            noisy = logits.detach().unsqueeze(0) + eps
            probabilities = torch.softmax(noisy.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                reward = proper_reward(probabilities, target.unsqueeze(0), qtype, mask, w_sph=0.75, w_rps=1.0)
                advantage = reward - reward.mean(0, keepdim=True)
                advantage = advantage / (advantage.std() + 1e-6)
            logp = -(((noisy - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(advantage * logp).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + loss_ce + 0.0 * activation.float().sum()) / grad_accum
            loss.backward()
            n_batches += 1
            if n_batches % grad_accum == 0 or start + micro_batch >= len(train_items):
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
            total_loss += loss.item() * grad_accum
        log["epoch_loss"].append(round(total_loss / max(1, n_batches), 4))
        print("epoch %d/%d loss=%.4f" % (epoch + 1, epochs, log["epoch_loss"][-1]), file=sys.stderr)
    model.eval()
    samples, by_bucket = [], collections.defaultdict(list)
    with torch.no_grad():
        for start in range(0, len(calib_items), micro_batch):
            chunk = calib_items[start:start + micro_batch]
            ids, attention, positions, mask, target, qtype = (t.to(target_device) for t in collate(chunk, tokenizer.pad_token_id))
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=use_autocast):
                logits, _ = model(ids, attention, positions, mask, qtype)
            for index, item in enumerate(chunk):
                sample = (logits[index, :len(item["markers"])].float().cpu(), item["target"])
                samples.append(sample)
                by_bucket[temp_bucket(0, len(item["markers"]))].append(sample)
    choice_temperature = fit_temperature(samples) or 1.0
    bucket_temperatures = {b: t for b, g in sorted(by_bucket.items()) for t in [fit_temperature(g)] if t is not None}
    temperature = list(base_cfg.get("temperature", [1.0, 1.0, 1.0]))
    temperature[0] = choice_temperature
    with torch.no_grad():
        model.temperature[0] = choice_temperature
    cfg.update({"fine_tuned": True, "model_name": "laya-taskshape", "temperature": temperature, "temperature_by_options": bucket_temperatures,
                "training": {**base_cfg.get("training", {}), "fine_tuned_from_checkpoint": True, "taskshape_updates": updates, "taskshape_epochs": epochs},
                "taskshape": {"base_checkpoint": str(base), "base_sha256": log["base_sha256"], "train_dataset": str(train_path),
                              "train_sha256": log["train_sha256"], "seed": seed, "train_top_layers": train_top_layers, "finished_at": time.time()}})
    save_file({n: v.detach().half().cpu().contiguous() for n, v in model.state_dict().items()}, str(out_dir / "model.safetensors"))
    model.encoder.config.save_pretrained(str(out_dir / "encoder"))
    tokenizer.save_pretrained(str(out_dir / "tokenizer"))
    (out_dir / "rl_agent_config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    log.update({"finished_at": time.time(), "seconds": round(time.time() - log["started_at"], 1), "choice_temperature": choice_temperature,
                "bucket_temperatures": bucket_temperatures, "output_sha256": sha256_file(out_dir / "model.safetensors"),
                "peak_memory_bytes": torch.cuda.max_memory_allocated() if target_device.type == "cuda" else None})
    (out_dir / "training-log.json").write_text(json.dumps(log, indent=2), encoding="utf-8")
    return log


# ----------------------------------------------------------------------------- comparison and adoption

def compare(baseline: dict, candidate: dict, min_gain: float = 0.0, max_ece_loss: float = 0.05, overconfidence: float = 0.05) -> dict:
    """Candidate wins only if accuracy never drops on a shared split, each split scored the same dataset file,
    and no split became over-confident (ECE up by more than `max_ece_loss` while confidence exceeds accuracy)."""
    common = sorted(set(baseline["splits"]) & set(candidate["splits"]))
    if not common:
        raise ValueError("Reports share no dataset split")
    rows, wins, improved = [], True, False
    for split in common:
        before, after = baseline["splits"][split]["metrics"], candidate["splits"][split]["metrics"]
        gain = round(after["accuracy"] - before["accuracy"], 4)
        ece_delta = round((after["ece"] or 0) - (before["ece"] or 0), 4)
        row = {"split": split, "n": after["n"], "baseline_accuracy": before["accuracy"], "candidate_accuracy": after["accuracy"],
               "accuracy_gain": gain, "baseline_ece": before["ece"], "candidate_ece": after["ece"], "ece_delta": ece_delta,
               "baseline_confidence": before["mean_answer_confidence"], "candidate_confidence": after["mean_answer_confidence"],
               "candidate_overconfident": after["mean_answer_confidence"] > after["accuracy"] + overconfidence,
               "same_dataset": baseline["splits"][split].get("dataset_sha256") == candidate["splits"][split].get("dataset_sha256")}
        rows.append(row)
        if gain < -min_gain - 1e-9 or (ece_delta > max_ece_loss and row["candidate_overconfident"]) or not row["same_dataset"]:
            wins = False
        if gain > 0:
            improved = True
    return {"wins": wins and improved, "rows": rows, "baseline": baseline["checkpoint"], "candidate": candidate["checkpoint"]}


def markdown_comparison(result: dict) -> str:
    lines = ["| split | n | baseline acc | candidate acc | gain | baseline ECE | candidate ECE | baseline conf | candidate conf |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in result["rows"]:
        lines.append("| %s | %d | %.3f | %.3f | %+.3f | %s | %s | %.3f | %.3f |" % (
            r["split"], r["n"], r["baseline_accuracy"], r["candidate_accuracy"], r["accuracy_gain"], r["baseline_ece"], r["candidate_ece"],
            r["baseline_confidence"], r["candidate_confidence"]))
    lines.append("")
    lines.append("Candidate %s: `%s` versus `%s`." % ("WINS" if result["wins"] else "does not win", result["candidate"], result["baseline"]))
    return "\n".join(lines)


def load_config(path) -> dict:
    path = Path(path)
    if not path.exists():
        return {"version": 1, "checkpoint": None, "revision": None, "head_max_len": DEFAULT_HEAD_MAX_LEN}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("Invalid taskshape config: %s" % path)
    return value


def adopt(config_path, checkpoint, baseline: dict, candidate: dict, meta: dict) -> dict:
    """Point the runtime config at `checkpoint` only when every gate holds; refuse loudly otherwise."""
    for name, report in (("baseline", baseline), ("candidate", candidate)):
        missing = [s for s in REQUIRED_SPLITS if s not in report.get("splits", {})]
        if missing:
            raise ValueError("%s report lacks required split(s): %s" % (name, ", ".join(missing)))
    result = compare(baseline, candidate)
    if not result["wins"]:
        raise ValueError("Candidate does not win on every split; configuration unchanged")
    checkpoint = resolve_checkpoint(checkpoint)
    digest = sha256_file(checkpoint / "model.safetensors")
    if candidate.get("checkpoint_sha256") != digest:
        raise ValueError("Candidate report was not produced by this checkpoint")
    cfg = json.loads((checkpoint / "rl_agent_config.json").read_text(encoding="utf-8"))
    provenance = cfg.get("taskshape", {})
    train_sha = meta.get("files", {}).get("train", {}).get("sha256")
    if not train_sha or provenance.get("train_sha256") != train_sha:
        raise ValueError("Checkpoint was not trained on the dataset build that produced the held-out split")
    for split in REQUIRED_SPLITS:
        if candidate["splits"][split].get("dataset_sha256") != meta.get("files", {}).get(split, {}).get("sha256"):
            raise ValueError("Held-out split in the candidate report is not the one from this dataset build")
    current = load_config(config_path)
    if current.get("checkpoint"):
        live = resolve_checkpoint(current["checkpoint"])
        if baseline.get("checkpoint_sha256") != sha256_file(live / "model.safetensors"):
            raise ValueError("Baseline report was not produced by the currently configured checkpoint")
    updated = {**current, "version": 1, "checkpoint": str(checkpoint), "revision": "sha256:" + digest,
               "head_max_len": current.get("head_max_len", DEFAULT_HEAD_MAX_LEN), "adopted_at": time.time()}
    Path(config_path).write_text(json.dumps(updated, indent=2), encoding="utf-8")
    return {"previous": current, "current": updated, "comparison": result}
