"""Task shapes: the stable taxonomy Laya is asked about.

Each shape has a required capability class (0-4) that the policy table compares with a profile's
capability, and a criterion text Laya reads. Criteria must stay under Laya's 48-token option cap
(label included); `taskshape lab budget` checks them with the real tokenizer.
"""
from __future__ import annotations

CAPABILITY_LEVELS = {0: "mechanical", 1: "routine", 2: "demanding", 3: "coupled", 4: "frontier"}

SHAPES = {
    "lookup": {
        "capability": 0,
        "criteria": "Mechanical exact lookup: find a file, string or value; extraction or classification with no judgment.",
    },
    "routine": {
        "capability": 1,
        "criteria": "Routine bounded change with an approved plan and clear acceptance: small edits, test-only or docs-only work, renames, config tweaks, read-only discovery.",
    },
    "demanding": {
        "capability": 2,
        "criteria": "Bounded single-subsystem repair or feature needing deeper reasoning: cause not fully known, several steps, must verify with tests, captures or a reproduction.",
    },
    "visual": {
        "capability": 2,
        "needs": ["vision"],
        "criteria": "Visual design or inspection of screenshots, mockups, layouts and image assets; needs image understanding.",
    },
    "coupled": {
        "capability": 3,
        "criteria": "Coupled correctness or high-risk work: persistence, migrations, concurrency, security boundaries, several systems or files, root-cause diagnosis, regression strategy.",
    },
    "review": {
        "capability": 3,
        "criteria": "Independent read-only review or verification of a bounded change against its plan, tests and rules.",
    },
    "architecture": {
        "capability": 4,
        "criteria": "Architecture, planning, specification authoring or critique, design disputes, escalation after failed attempts, hardest open-ended reasoning.",
    },
}

PHASES = ("work", "review")
INSTRUCTIONS = ("Pick the shape that matches the hardest demand of this task. Escalate only for coupled "
                "correctness, root-cause diagnosis, architecture or disputes; routine bounded edits stay routine.")


def shapes_for(phase: str) -> list[str]:
    """Shapes a phase may take: review phases only review or plan-level critique (architecture)."""
    if phase not in PHASES:
        raise ValueError("Unknown phase: %r" % (phase,))
    if phase == "review":
        return ["review", "architecture"]
    return [name for name in SHAPES if name != "review"]


def required_capability(shape: str) -> int:
    return SHAPES[shape]["capability"]


def distance(a: str, b: str) -> int:
    return abs(SHAPES[a]["capability"] - SHAPES[b]["capability"])
