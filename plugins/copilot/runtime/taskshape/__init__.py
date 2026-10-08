"""taskshape: classify the shape of a task with Laya, pick the cheapest adequate model from a policy table."""
from .shapes import SHAPES, shapes_for
from .catalog import load_models, load_profiles
from .policy import choose
from .router import route, HeuristicBackend, LayaBackend, Decision
from .context_selection import select_context

__all__ = ["SHAPES", "shapes_for", "load_models", "load_profiles", "choose", "route",
           "HeuristicBackend", "LayaBackend", "Decision", "select_context"]
__version__ = "0.2.0"
