"""taskshape command line: route, validate, record, report, lab."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

from . import lab as labmod
from . import records as recmod
from .catalog import load_models, load_profiles
from .policy import table
from .router import HeuristicBackend, LayaBackend, route

HERE = Path(__file__).resolve().parent


def _default_data(name: str) -> Path | None:
    for base in (HERE / "data", HERE.parent.parent.parent / "catalog"):
        path = base / name
        if path.exists():
            return path
    return None


DEFAULT_CATALOG = _default_data("models.json")
DEFAULT_PROFILES = _default_data("profiles.example.json")


def _read_stdin() -> str:
    """Read stdin as UTF-8 whatever the locale: a cp1252 console would otherwise garble or reject accents."""
    stream = getattr(sys.stdin, "buffer", None)
    return stream.read().decode("utf-8") if stream is not None else sys.stdin.read()


def _write(text: str, stream) -> None:
    """Write UTF-8 bytes whatever the console encoding: a cp1252 stdout would raise on accents or Cyrillic."""
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        stream.write(text)
        return
    stream.flush()
    buffer.write(text.encode("utf-8"))
    buffer.flush()


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _profiles(args):
    models = load_models(args.catalog) if args.catalog else None
    value = load_profiles(args.profiles, models)
    return value, models


def cmd_route(args):
    task = _read_stdin() if args.task_stdin else args.task
    value, _ = _profiles(args)
    budget = value["budgets"].get(args.budget)
    if budget is None:
        raise ValueError("Unknown budget %r; known: %s" % (args.budget, ", ".join(value["budgets"])))
    config = labmod.load_config(args.config) if args.config else {}
    checkpoint = args.checkpoint or config.get("checkpoint")
    if args.backend == "laya" or (args.backend == "auto" and checkpoint):
        if not checkpoint:
            raise ValueError("--backend laya needs --checkpoint or a config with a checkpoint")
        backend = LayaBackend(checkpoint, device=args.device)
    else:
        backend = HeuristicBackend(role=args.role)
    allowed = {item.strip() for item in args.allowed.split(",") if item.strip()} if args.allowed else None
    if allowed is not None:
        unknown = allowed - {p["id"] for p in value["profiles"]}
        if unknown:
            raise ValueError("--allowed names unknown profiles: %s" % ", ".join(sorted(unknown)))
    decision = route(task, value["profiles"], args.phase, budget["max_cost_tier"], backend, allowed=allowed,
                     head_max_len=config.get("head_max_len", labmod.DEFAULT_HEAD_MAX_LEN))
    result = decision.as_dict()
    if args.log:
        recmod.append_decision(args.log, result, origin=args.origin)
    return result


def cmd_validate(args):
    value, models = _profiles(args)
    return {"catalog": str(args.catalog) if args.catalog else None, "models": len(models["models"]) if models else None,
            "profiles": [p["id"] for p in value["profiles"]], "budgets": list(value["budgets"]),
            "policy_table": {phase: table(value["profiles"], value["budgets"], phase) for phase in ("work", "review")}}


def cmd_record(args):
    models = load_models(args.catalog) if args.catalog else None
    return recmod.record(args.file, args.shape, args.profile, args.model, args.effort, args.accepted, args.task or "",
                         args.outcome, args.input_tokens, args.output_tokens, args.seconds, models)


def cmd_report(args):
    value, _ = _profiles(args)
    return recmod.report(recmod.load(args.file), value["profiles"], args.min_samples, args.min_acceptance)


def cmd_lab(args):
    if args.lab_action == "dataset":
        return labmod.build_dataset(args.briefs, args.out, args.seed, args.heldout_fraction)
    if args.lab_action == "budget":
        return labmod.check_budget(args.checkpoint)
    if args.lab_action == "eval":
        report = labmod.evaluate(args.checkpoint, args.dataset, args.out, args.device)
        return {"out": str(args.out), "splits": {n: s["metrics"] for n, s in report["splits"].items()}}
    if args.lab_action == "finetune":
        return labmod.finetune(args.base, args.train, args.out, args.device, args.epochs, args.micro_batch, args.grad_accum,
                               args.train_top_layers, args.calib_fraction, args.seed)
    if args.lab_action == "compare":
        result = labmod.compare(_read_json(args.baseline), _read_json(args.candidate))
        if args.markdown:
            Path(args.markdown).write_text(labmod.markdown_comparison(result) + "\n", encoding="utf-8")
        return result
    return labmod.adopt(args.config, args.checkpoint, _read_json(args.baseline),
                        _read_json(args.candidate), _read_json(args.meta))


def build_parser():
    parser = argparse.ArgumentParser(prog="taskshape", description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)

    def profile_args(p):
        p.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
        p.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)

    p = sub.add_parser("route", help="classify a task and pick a profile")
    profile_args(p)
    task_source = p.add_mutually_exclusive_group(required=True)
    task_source.add_argument("--task")
    task_source.add_argument("--task-stdin", action="store_true", help="read the task text from stdin")
    p.add_argument("--phase", choices=("work", "review"), default="work")
    p.add_argument("--budget", default="default")
    p.add_argument("--backend", choices=("auto", "heuristic", "laya"), default="auto")
    p.add_argument("--checkpoint")
    p.add_argument("--config", type=Path)
    p.add_argument("--device", default="cpu")
    p.add_argument("--role")
    p.add_argument("--log", help="append the decision to this JSONL file (audit trail)")
    p.add_argument("--origin", default="cli", help="who asked: cli, mcp, claude-code-plugin, ...")
    p.add_argument("--allowed", help="comma-separated profile ids the choice is restricted to (a harness ceiling)")
    p = sub.add_parser("validate", help="validate catalog and profiles; print the policy table")
    profile_args(p)
    p = sub.add_parser("record", help="append an execution outcome")
    p.add_argument("--file", required=True)
    p.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    for name in ("--shape", "--profile", "--model", "--effort"):
        p.add_argument(name, required=True)
    p.add_argument("--accepted", action=argparse.BooleanOptionalAction, required=True)
    p.add_argument("--task")
    p.add_argument("--outcome")
    p.add_argument("--input-tokens", type=int)
    p.add_argument("--output-tokens", type=int)
    p.add_argument("--seconds", type=float)
    p = sub.add_parser("report", help="acceptance and cost per shape and profile")
    profile_args(p)
    p.add_argument("--file", required=True)
    p.add_argument("--min-samples", type=int, default=10)
    p.add_argument("--min-acceptance", type=float, default=0.85)
    lab = sub.add_parser("lab", help="dataset, budget, eval, finetune, compare, adopt").add_subparsers(dest="lab_action", required=True)
    p = lab.add_parser("dataset")
    p.add_argument("--briefs", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=20261005)
    p.add_argument("--heldout-fraction", type=float, default=0.2)
    lab.add_parser("budget").add_argument("--checkpoint", required=True)
    p = lab.add_parser("eval")
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--dataset", action="append", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--device", default="auto")
    p = lab.add_parser("finetune")
    p.add_argument("--base", required=True)
    p.add_argument("--train", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--device", default="auto")
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--micro-batch", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--train-top-layers", type=int, default=8)
    p.add_argument("--calib-fraction", type=float, default=0.15)
    p.add_argument("--seed", type=int, default=20261005)
    p = lab.add_parser("compare")
    p.add_argument("--baseline", required=True)
    p.add_argument("--candidate", required=True)
    p.add_argument("--markdown")
    p = lab.add_parser("adopt")
    p.add_argument("--config", required=True)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--baseline", required=True)
    p.add_argument("--candidate", required=True)
    p.add_argument("--meta", required=True)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {"route": cmd_route, "validate": cmd_validate, "record": cmd_record, "report": cmd_report, "lab": cmd_lab}
    try:
        print(json.dumps(handlers[args.action](args), ensure_ascii=False, indent=1, default=str))
        return 0
    except (ValueError, OSError, KeyError, RuntimeError, FileNotFoundError) as exc:
        print("%s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
