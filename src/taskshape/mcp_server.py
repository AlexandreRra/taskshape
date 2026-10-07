"""taskshape MCP server (stdio): `route`, `record`, `report` and `policy_table` as tools for any MCP client.

Run:  taskshape-mcp --profiles profiles.json [--catalog models.json] [--config taskshape.json]
      [--records records/outcomes.jsonl] [--decisions records/decisions.jsonl] [--backend auto|heuristic|laya]
The client (Claude Code, Codex, ...) starts this process locally and talks over stdin/stdout; no port,
no network. The Laya checkpoint named in the config is loaded once, on the first `route`, and stays warm.
"""
from __future__ import annotations
import argparse
import json
import os
import sys

from . import lab as labmod
from . import records as recmod
from .catalog import load_models, load_profiles
from .policy import table
from .router import HeuristicBackend, LayaBackend, route


class Service:
    def __init__(self, profiles_path, catalog_path=None, config_path=None, records_path=None, decisions_path=None,
                 backend="auto", device="cpu"):
        self.models = load_models(catalog_path) if catalog_path else None
        self.profiles = load_profiles(profiles_path, self.models)
        self.config = labmod.load_config(config_path) if config_path else {}
        self.records_path = records_path
        self.decisions_path = decisions_path
        self.backend_name = backend
        self.device = device
        self._backend = None

    def backend(self):
        if self._backend is None:
            checkpoint = self.config.get("checkpoint")
            if self.backend_name == "laya" or (self.backend_name == "auto" and checkpoint):
                if not checkpoint:
                    raise ValueError("backend laya needs a config with a checkpoint")
                self._backend = LayaBackend(checkpoint, device=self.device)
            else:
                self._backend = HeuristicBackend()
        return self._backend

    def route(self, task: str, phase: str = "work", budget: str = "default", context: dict | None = None) -> dict:
        budget_value = self.profiles["budgets"].get(budget)
        if budget_value is None:
            raise ValueError("Unknown budget %r; known: %s" % (budget, ", ".join(self.profiles["budgets"])))
        decision = route(task, self.profiles["profiles"], phase, budget_value["max_cost_tier"], self.backend(), context,
                         head_max_len=self.config.get("head_max_len", labmod.DEFAULT_HEAD_MAX_LEN)).as_dict()
        if self.decisions_path:
            recmod.append_decision(self.decisions_path, decision, origin="mcp")
        return decision

    def record(self, shape: str, profile: str, model: str, effort: str, accepted: bool, task: str = "",
               outcome: str | None = None, input_tokens: int | None = None, output_tokens: int | None = None,
               seconds: float | None = None) -> dict:
        if not self.records_path:
            raise ValueError("No records file configured (--records)")
        return recmod.record(self.records_path, shape, profile, model, effort, accepted, task, outcome,
                             input_tokens, output_tokens, seconds, self.models)

    def report(self, min_samples: int = 10, min_acceptance: float = 0.85) -> dict:
        rows = recmod.load(self.records_path) if self.records_path else []
        return recmod.report(rows, self.profiles["profiles"], min_samples, min_acceptance)

    def policy_table(self) -> dict:
        return {phase: table(self.profiles["profiles"], self.profiles["budgets"], phase) for phase in ("work", "review")}


def build_server(service: Service):
    from mcp.server.mcpserver import MCPServer  # mcp >= 2 (FastMCP was renamed)
    server = MCPServer("taskshape", instructions=(
        "Call `route` before delegating a task to a sub-agent: it returns the task shape, the cheapest adequate "
        "model+effort profile under the budget, the reason and warnings. After the task finishes, call `record` "
        "with the outcome so the policy table can be tuned from evidence. Never calls a provider."))

    @server.tool()
    def route(task: str, phase: str = "work", budget: str = "default") -> dict:
        """Classify a task brief and pick the cheapest adequate model profile. phase: work|review."""
        return service.route(task, phase, budget)

    @server.tool()
    def record(shape: str, profile: str, model: str, effort: str, accepted: bool, task: str = "",
               outcome: str = "", input_tokens: int | None = None, output_tokens: int | None = None,
               seconds: float | None = None) -> dict:
        """Append the outcome of a routed task (accepted or not, tokens, seconds) to the records file."""
        return service.record(shape, profile, model, effort, accepted, task, outcome or None, input_tokens, output_tokens, seconds)

    @server.tool()
    def report(min_samples: int = 10, min_acceptance: float = 0.85) -> dict:
        """Acceptance and cost per shape and profile from the records, with the cheapest profile that holds up per shape."""
        return service.report(min_samples, min_acceptance)

    @server.tool()
    def policy_table() -> dict:
        """What every budget picks for every shape, for both phases."""
        return service.policy_table()

    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="taskshape-mcp", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--catalog")
    parser.add_argument("--config")
    parser.add_argument("--records")
    parser.add_argument("--decisions")
    parser.add_argument("--backend", choices=("auto", "heuristic", "laya"), default="auto")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--selftest", action="store_true", help="instantiate the service and tools, print a route, exit")
    args = parser.parse_args(argv)
    try:
        service = Service(args.profiles, args.catalog, args.config, args.records, args.decisions, args.backend, args.device)
        server = build_server(service)
    except (ValueError, OSError, ImportError) as exc:
        print("%s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 1
    if args.selftest:
        import asyncio
        tools = asyncio.run(server.list_tools())
        print(json.dumps({"tools": sorted(t.name for t in tools), "route": service.route("Fix the typo in README"),
                          "cwd": os.getcwd()}, indent=1))
        return 0
    server.run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
