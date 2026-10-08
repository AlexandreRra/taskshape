#!/usr/bin/env python3
"""Evaluate and optionally specialize a local Laya checkpoint on the public synthetic briefs.

Checkpoint files and Python dependencies must already be local. Training and evaluation disable
network access. No private records or other datasets are read.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from taskshape import lab
from taskshape.rubric import classify


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def prepare(dataset: Path, destination: Path) -> tuple[dict, dict]:
    destination.mkdir(parents=True, exist_ok=True)
    briefs, paths = {}, {}
    for split in ("train", "heldout"):
        rows = lab.read_jsonl(dataset / f"{split}.jsonl")
        if not rows or any(row.get("source") != "synthetic-curated" or not row.get("shape") for row in rows):
            raise ValueError("Public briefs require explicit synthetic-curated labels")
        prepared = []
        for brief in rows:
            row = lab.make_row(brief["id"], brief, lab.DEFAULT_HEAD_MAX_LEN)
            if row is None:
                raise ValueError("Public brief has a shape incompatible with its phase")
            row["labelled_by"] = "synthetic-curated"
            prepared.append(row)
        path = destination / f"{split}.jsonl"
        lab.write_jsonl(path, prepared)
        briefs[split], paths[split] = rows, path
    if {row["task"] for row in briefs["train"]} & {row["task"] for row in briefs["heldout"]}:
        raise ValueError("Training and heldout tasks overlap")
    if {row["template"] for row in briefs["train"]} & {row["template"] for row in briefs["heldout"]}:
        raise ValueError("Training and heldout templates overlap")
    return briefs, paths


def report(checkpoint: Path, heldout: Path, briefs: list[dict], output: Path) -> dict:
    value = lab.evaluate(checkpoint, [heldout], output, device="cpu")
    results = value["splits"]["heldout"]["results"]
    metadata = {row["id"]: row for row in briefs}
    value["by_language"] = {
        language: lab.metrics_for([row for row in results if metadata[row["id"]]["language"] == language])
        for language in sorted({row["language"] for row in briefs})
    }
    value["by_phase"] = {
        phase: lab.metrics_for([row for row in results if metadata[row["id"]]["phase"] == phase])
        for phase in sorted({row["phase"] for row in briefs})
    }
    write_json(output, value)
    return value


def rubric_reference(briefs: list[dict]) -> dict:
    def accuracy(rows: list[dict]) -> dict:
        correct = sum(classify(row["task"], row["phase"]) == row["shape"] for row in rows)
        return {"n": len(rows), "correct": correct, "accuracy": round(correct / len(rows), 4)}
    return {
        "overall": accuracy(briefs),
        "by_language": {
            language: accuracy([row for row in briefs if row["language"] == language])
            for language in sorted({row["language"] for row in briefs})
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=Path("checkpoints/public-multilingual"))
    parser.add_argument("--candidate", type=Path, default=Path("checkpoints/public-taskshape"))
    parser.add_argument("--dataset", type=Path, default=Path("datasets/public-routing"))
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20261008)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--baseline-only", action="store_true")
    selection.add_argument("--evaluate-only", action="store_true", help="evaluate an already trained candidate without training")
    args = parser.parse_args()
    if args.epochs < 1 or args.threads < 1:
        parser.error("epochs and threads must be positive")

    import torch
    torch.set_num_threads(args.threads)
    lab.deny_network()
    briefs, paths = prepare(args.dataset, args.base / "public-routing-inputs")
    evaluation = {
        "version": 1,
        "label_source": "agent-authored synthetic-curated; not independently human-validated",
        "limitations": "Small synthetic EN/PT-BR benchmark; not evidence of general production accuracy.",
        "source_datasets": {
            split: {"sha256": lab.sha256_file(args.dataset / f"{split}.jsonl"), "rows": len(rows)}
            for split, rows in briefs.items()
        },
        "packages": {name: importlib.metadata.version(name) for name in ("laya", "torch", "transformers", "safetensors")},
        "rubric_reference": rubric_reference(briefs["heldout"]),
        "head_budget": lab.check_budget(args.base),
        "baseline": report(args.base, paths["heldout"], briefs["heldout"], args.base / "public-routing-evaluation.json"),
    }
    write_json(args.dataset / "evaluation.json", evaluation)
    print("baseline", evaluation["baseline"]["splits"]["heldout"]["metrics"], flush=True)
    if args.baseline_only:
        return

    if not args.evaluate_only:
        training = lab.finetune(args.base, paths["train"], args.candidate, device="cpu", epochs=args.epochs,
                                micro_batch=2, grad_accum=4, train_top_layers=0, seed=args.seed)
        training["label_source"] = evaluation["label_source"]
        training["source_train_sha256"] = evaluation["source_datasets"]["train"]["sha256"]
        training["packages"] = evaluation["packages"]
        write_json(args.dataset / "training.json", training)
    evaluation["candidate"] = report(args.candidate, paths["heldout"], briefs["heldout"],
                                      args.candidate / "public-routing-evaluation.json")
    evaluation["comparison"] = lab.compare(evaluation["baseline"], evaluation["candidate"])
    meta = {"files": {split: {"sha256": lab.sha256_file(path)} for split, path in paths.items()}}
    with tempfile.TemporaryDirectory(prefix="adoption-check-", dir=args.candidate) as temporary:
        try:
            lab.adopt(Path(temporary) / "taskshape.json", args.candidate,
                      evaluation["baseline"], evaluation["candidate"], meta)
            evaluation["adoption_gate"] = {"passed": True}
        except ValueError as error:
            evaluation["adoption_gate"] = {"passed": False, "reason": str(error)}
    write_json(args.dataset / "evaluation.json", evaluation)
    (args.dataset / "comparison.md").write_text(
        lab.markdown_comparison(evaluation["comparison"])
        + "\n\nLabels are agent-authored synthetic examples, not independent human validation. "
        + "The same heldout split was used for baseline and candidate evaluation.\n", encoding="utf-8")
    print("candidate", evaluation["candidate"]["splits"]["heldout"]["metrics"], flush=True)
    print("adoption_gate_passed", evaluation["adoption_gate"]["passed"], flush=True)


if __name__ == "__main__":
    main()
