"""Transparent keyword rubric: a labeller for datasets and a fallback backend when no checkpoint is available.

It strips cited sources ("applies RFC-7", "per the spec") and negated clauses ("no schema changes",
"rules untouched") before looking for coupled or architecture cues, so references do not escalate a
brief. It is deliberately simple; the point of the project is to replace it with a fine-tuned Laya.
"""
from __future__ import annotations
import re

from .shapes import SHAPES, shapes_for

# Only the reference itself is removed ("per the migration guide", "RFC-7", "§4.2"), never the rest of the sentence.
CITED = re.compile(r"(?:\b(?:(?:applies|applying|conforms? to|cites?|cited|per|see|according to)\s+(?:the\s+)?(?:[\w-]+\s+)?"
                   r"(?:spec|specification|rfc|adr|docs?|documentation|guide|ticket|section)\b|rfc[- ]?\d+\b)|§\s*[\d.]+)", re.I)
NEGATED_AFTER = re.compile(r"\b(no|not|never|without|cannot|must not|do not|does not|don't)\b[^.;,\n]{0,60}", re.I)
NEGATED_BEFORE = re.compile(r"[^.;,\n]{0,40}\b(untouched|unchanged|unaffected|out of scope|preserved|as is)\b", re.I)

ROLE_HINTS = {
    "lookup": "lookup", "explore": "routine", "executor": None, "executor-complex": "coupled", "debugger": "coupled",
    "test-engineer": None, "planner": "architecture", "architect": "architecture", "analyst": "architecture",
    "critic": "architecture", "code-reviewer": "review", "verifier": "review", "security-reviewer": "review",
    "designer": "visual", "vision": "visual",
}

CUES = {
    # matched on the cleaned text
    "architecture": r"\b(plan|write|author|draft|produce|own)\b[^.;]{0,60}\b(prd|spec|specification|rfc|adr|design doc)\b|\barchitecture\b|\barchitect\b|design (decision|review|approach)|tradeoffs?|dispute|requirements? analysis|roadmap|milestone plan",
    "coupled": r"persist|schema|migration|serializ|\breplay\b|data loss|corrupt|idempoten|transaction|concurren|\brace\b|thread|deadlock|\block(s|ed|ing)?\b|security|authori[sz]\w*|authent\w*|\bauthn\b|\bauthz\b|\boauth\d*\b|\bauth\b|permission|several (files|systems|services)|cross-service|coupled|high[- ]risk|root[- ]cause|diagnos|hypothes[ie]s|regression (isolation|strategy)|duplicate[d]? (rewards?|charges?|events?)",
    "escalation": r"two (unsuccessful|failed|materially)|third attempt|escalat|second independent review|disput",
    "visual": r"screenshot|mockup|wireframe|pixel[- ]art|sprite|visual (review|design|polish)|layout review|asset review|\bui design\b|figma|png\b",
    # matched on the raw text
    "demanding_strong": r"not (yet )?(confirmed|known|proven)|unproven|unconfirmed|red/green|live oracle|build an? oracle|reproduce|several steps|multi-step|end[- ]to[- ]end|all controls reachable|runtime regression|performance",
    "demanding": r"captures?\b|rendered|smoke|integration test|refactor|implement (the|a) \w+ feature|feature\b|debug\b",
    "routine": r"test-only|docs-only|no code edits|no production edits|wording|\blabel\b|contrast|\bdocs?\b|readme|changelog|backlog|rename|typo|append|register the|fixture|synced|assertion for|list (the|every)|summarize|split the|config (tweak|change)|bump|lint|format",
    "lookup": r"\bfind (the )?(exact|string|file|line)|\bgrep\b|locate the (file|string|definition)|where is\b|which file\b|exact (file|string) lookup",
}


def clean_text(text: str) -> str:
    text = CITED.sub(" ", text)
    text = NEGATED_BEFORE.sub(" ", text)
    text = NEGATED_AFTER.sub(" ", text)
    return text


def features(text: str) -> dict[str, bool]:
    raw, cleaned = text.lower(), clean_text(text).lower()
    found = {}
    for name, pattern in CUES.items():
        source = cleaned if name in ("architecture", "coupled", "escalation", "visual") else raw
        found[name] = bool(re.search(pattern, source))
    return found


def classify(text: str, phase: str = "work", role: str | None = None) -> str:
    """Shape of a brief under the rubric; a known role name is a strong hint."""
    allowed = shapes_for(phase)
    hint = ROLE_HINTS.get(role) if role else None
    found = features(text)
    if phase == "review":
        if hint == "architecture" or found["escalation"] or found["architecture"]:
            return "architecture"
        return "review"
    if hint == "lookup" or (found["lookup"] and not found["coupled"] and not found["architecture"]):
        return "lookup"
    if hint == "architecture" or found["escalation"]:
        return "architecture"
    if hint == "routine":
        return "routine"
    if found["architecture"] and not found["routine"]:
        return "architecture"
    if hint == "visual" or found["visual"]:
        return "visual" if "visual" in allowed else "demanding"
    if hint == "coupled" or found["coupled"]:
        return "coupled"
    if found["demanding_strong"]:
        return "demanding"
    if found["routine"]:
        return "routine"
    if found["demanding"]:
        return "demanding"
    return "routine"


def soft_target(shape: str, options: list[str], gold_weight: float = 0.70) -> dict[str, float]:
    """Gold shape gets `gold_weight`; the rest decays with capability distance (for training targets)."""
    if shape not in options:
        raise ValueError("Gold shape is not an option")
    weights = {}
    for option in options:
        d = abs(SHAPES[option]["capability"] - SHAPES[shape]["capability"])
        weights[option] = {0: gold_weight, 1: 0.20, 2: 0.07}.get(d, 0.03) if option != shape else gold_weight
    # two shapes can share a capability level (visual/demanding, review/coupled): keep the gold on top
    for option in options:
        if option != shape and weights[option] >= gold_weight:
            weights[option] = 0.20
    total = sum(weights.values())
    return {k: round(v / total, 4) for k, v in weights.items()}
