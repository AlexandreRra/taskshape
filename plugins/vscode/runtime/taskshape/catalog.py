"""Model catalog (what models are good at, dated and sourced) and deployment profiles (what you may call)."""
from __future__ import annotations
import json
from pathlib import Path

from .shapes import PHASES

MAX_FILE_BYTES = 4 * 1024 * 1024
MODEL_FIELDS = {"id", "provider", "positioning"}
PROFILE_FIELDS = {"id", "model", "capability", "cost_tier"}


def _read(path) -> dict:
    path = Path(path)
    if path.is_symlink() or path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Refusing symlink or oversized file: %s" % path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except RecursionError:
        raise ValueError("JSON nested too deeply: %s" % path)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object: %s" % path)
    return value


def load_models(path) -> dict:
    """Validate catalog/models.json: a dated list of models with sources."""
    value = _read(path)
    if value.get("version") != 1 or not isinstance(value.get("models"), list):
        raise ValueError("Catalog must have version 1 and a models list")
    if not isinstance(value.get("as_of"), str) or not 0 < len(value["as_of"]) <= 32:
        raise ValueError("Catalog as_of must be a short date string")
    seen = set()
    for model in value["models"]:
        if not isinstance(model, dict) or MODEL_FIELDS - set(model):
            raise ValueError("Each model needs %s" % sorted(MODEL_FIELDS))
        if model["id"] in seen:
            raise ValueError("Duplicate model id: %s" % model["id"])
        seen.add(model["id"])
        price = model.get("price_per_mtok", {})
        if not isinstance(price, dict) or any(v is not None and not isinstance(v, str) and (isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0)
                                             for v in price.values()):
            raise ValueError("price_per_mtok must map names to non-negative numbers, null or a note: %s" % model["id"])
        sources = model.get("sources", [])
        if not isinstance(sources, list) or not all(isinstance(s, str) for s in sources):
            raise ValueError("sources must be a list of URLs: %s" % model["id"])
    return value


def load_profiles(path, models: dict | None = None) -> dict:
    """Validate a deployment's profiles: authorized model+effort pairs with capability, cost tier and phases."""
    value = _read(path)
    if value.get("version") != 1 or not isinstance(value.get("profiles"), list) or not value["profiles"]:
        raise ValueError("Profiles must have version 1 and a non-empty profiles list")
    known = {m["id"] for m in models["models"]} if models else None
    seen = set()
    for profile in value["profiles"]:
        if not isinstance(profile, dict) or PROFILE_FIELDS - set(profile):
            raise ValueError("Each profile needs %s" % sorted(PROFILE_FIELDS))
        if profile["id"] in seen:
            raise ValueError("Duplicate profile id: %s" % profile["id"])
        seen.add(profile["id"])
        profile.setdefault("effort", "default")
        if not isinstance(profile["effort"], str) or not profile["effort"]:
            raise ValueError("effort must be a non-empty string: %s" % profile["id"])
        for key, low, high in (("capability", 0, 4), ("cost_tier", 0, 5)):
            v = profile[key]
            if isinstance(v, bool) or not isinstance(v, int) or not low <= v <= high:
                raise ValueError("%s must be an integer in [%d, %d]: %s" % (key, low, high, profile["id"]))
        phases = profile.setdefault("phases", list(PHASES))
        if not isinstance(phases, list) or not phases or set(phases) - set(PHASES):
            raise ValueError("phases must be a non-empty subset of %s: %s" % (PHASES, profile["id"]))
        profile.setdefault("vision", False)
        if not isinstance(profile["vision"], bool):
            raise ValueError("vision must be a boolean: %s" % profile["id"])
        if known is not None and profile["model"] not in known:
            raise ValueError("Profile %s names a model missing from the catalog: %s" % (profile["id"], profile["model"]))
    budgets = value.setdefault("budgets", {"default": {"max_cost_tier": 5}})
    if not isinstance(budgets, dict) or not budgets:
        raise ValueError("budgets must be a non-empty object")
    for name, budget in budgets.items():
        cap = budget.get("max_cost_tier") if isinstance(budget, dict) else None
        if isinstance(cap, bool) or not isinstance(cap, int) or not 0 <= cap <= 5:
            raise ValueError("budget %s needs max_cost_tier in [0, 5]" % name)
    return value


def model_by_id(models: dict, model_id: str) -> dict | None:
    return next((m for m in models["models"] if m["id"] == model_id), None)


def estimate_cost_usd(models: dict, model_id: str, input_tokens: int, output_tokens: int) -> float | None:
    """List-price estimate from the catalog; None when the catalog has no verified price."""
    model = model_by_id(models, model_id)
    if not model:
        return None
    price = model.get("price_per_mtok", {})
    inp, out = price.get("input"), price.get("output")
    if not isinstance(inp, (int, float)) or not isinstance(out, (int, float)):
        return None
    return round((input_tokens * inp + output_tokens * out) / 1_000_000, 6)
