"""Execution records: what happened after a route, so the policy table can be tuned from evidence."""
from __future__ import annotations
import collections
import hashlib
import json
import os
import time

from .catalog import estimate_cost_usd
from .shapes import SHAPES

FIELDS = ("shape", "profile", "model", "effort", "accepted")


def record(path, shape: str, profile: str, model: str, effort: str, accepted: bool, task: str = "",
           outcome: str | None = None, input_tokens: int | None = None, output_tokens: int | None = None,
           seconds: float | None = None, models: dict | None = None) -> dict:
    if shape not in SHAPES or not isinstance(accepted, bool):
        raise ValueError("record needs a known shape and a boolean accepted")
    row = {"ts": time.time(), "task_sha256": hashlib.sha256(task.encode()).hexdigest()[:16] if task else None,
           "shape": shape, "profile": profile, "model": model, "effort": effort, "accepted": accepted,
           "outcome": (outcome or "")[:100] or None, "input_tokens": input_tokens, "output_tokens": output_tokens,
           "seconds": seconds,
           "cost_usd": estimate_cost_usd(models, model, input_tokens, output_tokens)
           if models and input_tokens is not None and output_tokens is not None else None}
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def append_decision(path, decision: dict, origin: str = "cli") -> dict:
    """Audit trail of routing decisions (what was suggested or enforced), separate from outcome records."""
    row = {"ts": time.time(), "origin": origin, "task_sha256": hashlib.sha256(decision.get("task", "").encode()).hexdigest()[:16],
           "phase": decision.get("phase"), "shape": decision.get("shape"), "profile": decision.get("profile"),
           "model": decision.get("model"), "effort": decision.get("effort"), "answer_confidence": decision.get("answer_confidence"),
           "source": decision.get("source"), "warnings": decision.get("warnings", [])}
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def load(path) -> list[dict]:
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and all(k in row for k in FIELDS):
                rows.append(row)
    return rows


def report(rows: list[dict], profiles: list[dict], min_samples: int = 10, min_acceptance: float = 0.85) -> dict:
    """Acceptance and cost per shape and profile, plus the cheapest profile that already holds up per shape."""
    by_key = collections.defaultdict(list)
    for row in rows:
        by_key[(row["shape"], row["profile"])].append(row)
    cost_tier = {p["id"]: p["cost_tier"] for p in profiles}
    cells, suggestions = {}, {}
    for (shape, profile), items in sorted(by_key.items()):
        accepted = sum(1 for r in items if r["accepted"])
        costs = [r["cost_usd"] for r in items if isinstance(r.get("cost_usd"), (int, float))]
        secs = [r["seconds"] for r in items if isinstance(r.get("seconds"), (int, float))]
        cells["%s/%s" % (shape, profile)] = {
            "n": len(items), "acceptance": round(accepted / len(items), 3),
            "mean_cost_usd": round(sum(costs) / len(costs), 4) if costs else None,
            "mean_seconds": round(sum(secs) / len(secs), 1) if secs else None,
            "cost_tier": cost_tier.get(profile)}
    for shape in SHAPES:
        holding = [(cost_tier.get(p, 99), p, c) for (s, p), items in by_key.items() if s == shape
                   for c in [cells["%s/%s" % (s, p)]] if c["n"] >= min_samples and c["acceptance"] >= min_acceptance]
        if holding:
            tier, profile, cell = min(holding)
            suggestions[shape] = {"cheapest_profile_holding_up": profile, "cost_tier": tier,
                                  "acceptance": cell["acceptance"], "n": cell["n"]}
    return {"rows": len(rows), "cells": cells, "suggestions": suggestions,
            "rule": "cheapest profile per shape with n >= %d and acceptance >= %.2f; a human applies it to profiles.json"
                    % (min_samples, min_acceptance)}
