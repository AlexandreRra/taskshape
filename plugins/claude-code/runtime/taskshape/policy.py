"""The policy table: shape + budget -> cheapest adequate profile, with the reason attached."""
from __future__ import annotations
from dataclasses import dataclass, field

from .shapes import SHAPES


@dataclass
class Choice:
    profile: dict
    reason: str
    warnings: list[str] = field(default_factory=list)
    considered: list[str] = field(default_factory=list)


def eligible(profiles: list[dict], phase: str, needs: list[str], allowed=None) -> list[dict]:
    out = []
    for profile in profiles:
        if phase not in profile.get("phases", ("work", "review")):
            continue
        if allowed is not None and profile["id"] not in allowed:
            continue
        if any(not profile.get(flag, False) for flag in needs):
            continue
        out.append(profile)
    return out


def choose(shape: str, profiles: list[dict], phase: str = "work", max_cost_tier: int = 5, allowed=None) -> Choice:
    """Cheapest profile whose capability covers the shape within the budget; else the most capable within budget."""
    if shape not in SHAPES:
        raise ValueError("Unknown shape: %r" % (shape,))
    required = SHAPES[shape]["capability"]
    needs = SHAPES[shape].get("needs", [])
    candidates = eligible(profiles, phase, needs, allowed)
    if not candidates:
        raise ValueError("No profile is eligible for phase %s and shape %s" % (phase, shape))
    within = [p for p in candidates if p["cost_tier"] <= max_cost_tier]
    if not within:
        raise ValueError("No eligible profile fits max_cost_tier=%d" % max_cost_tier)
    adequate = [p for p in within if p["capability"] >= required]
    considered = [p["id"] for p in sorted(within, key=lambda p: (p["cost_tier"], -p["capability"], p["id"]))]
    if adequate:
        pick = min(adequate, key=lambda p: (p["cost_tier"], -p["capability"], p["id"]))
        return Choice(pick, "cheapest profile whose capability %d covers %s (needs %d)" % (pick["capability"], shape, required),
                      considered=considered)
    pick = min(within, key=lambda p: (-p["capability"], p["cost_tier"], p["id"]))
    return Choice(pick, "most capable profile within the budget; none reaches capability %d" % required,
                  warnings=["under-provisioned: %s needs capability %d, %s has %d" % (shape, required, pick["id"], pick["capability"])],
                  considered=considered)


def table(profiles: list[dict], budgets: dict, phase: str = "work") -> dict:
    """What every budget would pick for every shape: the policy, made visible."""
    out = {}
    for shape in SHAPES:
        if phase == "review" and shape not in ("review", "architecture"):
            continue
        out[shape] = {}
        for name, budget in budgets.items():
            try:
                choice = choose(shape, profiles, phase, budget["max_cost_tier"])
                out[shape][name] = {"profile": choice.profile["id"], "warnings": choice.warnings}
            except ValueError as exc:
                out[shape][name] = {"profile": None, "warnings": [str(exc)]}
    return out
