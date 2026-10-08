"""Route a task: classify its shape (Laya or the rubric), then apply the policy table."""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
import hashlib
import os
import time

from .policy import choose
from .rubric import classify, soft_target
from .shapes import INSTRUCTIONS, SHAPES, shapes_for

DEFAULT_HEAD_MAX_LEN = 320
LOW_CONFIDENCE = 0.55


def task_hash(task: str) -> str:
    """Join key between a decision and its outcome: hash of the full task text, never of a truncated copy."""
    return hashlib.sha256(task.encode()).hexdigest()[:16]


def questions_for(phase: str, head_max_len: int = DEFAULT_HEAD_MAX_LEN) -> dict:
    options = shapes_for(phase)
    return {"shape": {"type": "choice", "instructions": INSTRUCTIONS,
                      "criteria": {name: SHAPES[name]["criteria"] for name in options}}}


def state_for(task: str, phase: str, context: dict | None = None) -> dict:
    state = {"task": str(task)[:4000], "phase": phase}
    if context:
        state["context"] = {str(k)[:40]: str(v)[:200] for k, v in list(context.items())[:10]}
    return state


class HeuristicBackend:
    """Rubric-based classifier: transparent, dependency-free, used when no checkpoint is configured."""
    name = "heuristic"

    def __init__(self, role: str | None = None):
        self.role = role

    def predict(self, state: dict, questions: dict, head_max_len: int | None = None) -> dict:
        answers = {}
        for qid, question in questions.items():
            options = list(question["criteria"])
            shape = classify(state["task"], state.get("phase", "work"), self.role)
            probabilities = soft_target(shape, options) if shape in options else {o: 1 / len(options) for o in options}
            answers[qid] = {"choice": max(probabilities, key=probabilities.get), "probabilities": probabilities,
                            "answer_confidence": max(probabilities.values()), "confidence": 0.0}
        return {"answers": answers}


class LayaBackend:
    """Laya checkpoint (base or fine-tuned), loaded lazily and offline; never downloads at route time."""
    name = "laya"

    def __init__(self, checkpoint: str, device: str = "cpu", threads: int = 2):
        if not os.path.isfile(os.path.join(checkpoint, "rl_agent_config.json")):
            raise FileNotFoundError("Not a Laya checkpoint directory: %s" % checkpoint)
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        import torch
        from laya import Agent
        torch.set_num_threads(threads)
        self.agent = Agent(checkpoint, device=device)
        self.checkpoint = checkpoint

    def predict(self, state: dict, questions: dict, head_max_len: int | None = None) -> dict:
        kwargs = {"head_max_len": head_max_len} if head_max_len else {}
        return self.agent.predict(state, questions, **kwargs)


@dataclass
class Decision:
    task: str
    phase: str
    shape: str
    shape_probabilities: dict
    answer_confidence: float
    entropy_confidence: float
    profile: str
    model: str
    effort: str
    reason: str
    source: str
    warnings: list = field(default_factory=list)
    considered: list = field(default_factory=list)
    seconds: float = 0.0
    task_sha256: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def validate_answer(answer: dict, options: list[str]) -> dict:
    """Reject anything that is not a finite distribution over exactly the offered shapes."""
    import math
    probabilities = answer.get("probabilities")
    if not isinstance(probabilities, dict) or set(probabilities) != set(options):
        raise ValueError("Answer does not cover the offered shapes")
    values = list(probabilities.values()) + [answer.get("answer_confidence"), answer.get("confidence")]
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 1 for v in values):
        raise ValueError("Answer scores must be finite numbers in [0, 1]")
    if abs(sum(probabilities.values()) - 1) > 0.002 or answer.get("choice") not in options:
        raise ValueError("Answer probabilities must sum to one and name an offered shape")
    if probabilities[answer["choice"]] < max(probabilities.values()) - 1e-9:
        raise ValueError("Choice is not the maximum-probability shape")
    return answer


def route(task: str, profiles: list[dict], phase: str = "work", max_cost_tier: int = 5, backend=None,
          context: dict | None = None, allowed=None, head_max_len: int = DEFAULT_HEAD_MAX_LEN,
          low_confidence: float = LOW_CONFIDENCE) -> Decision:
    started = time.monotonic()
    backend = backend or HeuristicBackend()
    questions = questions_for(phase)
    options = list(questions["shape"]["criteria"])
    warnings = []
    try:
        answer = validate_answer(backend.predict(state_for(task, phase, context), questions, head_max_len)["answers"]["shape"], options)
        source = getattr(backend, "name", type(backend).__name__)
    except (KeyError, TypeError, ValueError, RuntimeError, OSError) as exc:
        # The classifier failed or lied: fall back to the rubric and say so; never fail the route silently.
        answer = HeuristicBackend().predict(state_for(task, phase, context), questions)["answers"]["shape"]
        source = "heuristic-fallback"
        warnings.append("Backend unavailable or invalid; rubric used: " + str(exc)[:200])
    if answer["answer_confidence"] < low_confidence:
        warnings.append("Low shape confidence %.2f; policy still applied" % answer["answer_confidence"])
    choice = choose(answer["choice"], profiles, phase, max_cost_tier, allowed)
    warnings.extend(choice.warnings)
    return Decision(task=str(task)[:500], phase=phase, shape=answer["choice"],
                    shape_probabilities={k: round(float(v), 4) for k, v in answer["probabilities"].items()},
                    answer_confidence=round(float(answer["answer_confidence"]), 4),
                    entropy_confidence=round(float(answer["confidence"]), 4),
                    profile=choice.profile["id"], model=choice.profile["model"], effort=choice.profile.get("effort", "default"),
                    reason=choice.reason, source=source, warnings=warnings, considered=choice.considered,
                    seconds=round(time.monotonic() - started, 2),
                    task_sha256=task_hash(str(task)))
