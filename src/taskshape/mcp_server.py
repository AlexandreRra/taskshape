"""taskshape MCP server (stdio): routing, file relevance, records and policy tools for any MCP client.

Run:  taskshape-mcp --profiles profiles.json [--catalog models.json] [--config taskshape.json]
      [--records records/outcomes.jsonl] [--decisions records/decisions.jsonl] [--backend auto|heuristic|laya]
The client (Claude Code, Codex, ...) starts this process locally and talks over stdin/stdout; no port,
no network. The Laya checkpoint named in the config is loaded once, on the first `route`, and stays warm.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys

from . import lab as labmod
from . import records as recmod
from .catalog import load_models, load_profiles
from .policy import table
from .router import HeuristicBackend, LayaBackend, route
from .relevance import should_read_file as assess_file
from .context_selection import select_context as select_file_context

HERE = Path(__file__).resolve().parent


def _default_data(name: str) -> Path | None:
    for base in (HERE / "data", HERE.parent.parent.parent / "catalog"):
        path = base / name
        if path.exists():
            return path
    return None


DEFAULT_CATALOG = _default_data("models.json")
DEFAULT_PROFILES = _default_data("profiles.example.json")


class Service:
    def __init__(self, profiles_path, catalog_path=None, config_path=None, records_path=None, decisions_path=None,
                 backend="auto", device="cpu", root=None):
        catalog_path = catalog_path or DEFAULT_CATALOG
        profiles_path = profiles_path or DEFAULT_PROFILES
        self.models = load_models(catalog_path) if catalog_path else None
        self.profiles = load_profiles(profiles_path, self.models)
        self.config = labmod.load_config(config_path) if config_path else {}
        self.records_path = records_path
        self.decisions_path = decisions_path
        self.backend_name = backend
        self.device = device
        self._backend = None
        self.root = str(root) if root is not None else os.getcwd()

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

    def should_read_file(self, task: str, path: str, summary: str = "", excerpt: str = "") -> dict:
        try:
            backend = self.backend()
        except (ImportError, ValueError, OSError, RuntimeError):
            backend = None
        return assess_file(task, path, summary, excerpt, backend,
                           head_max_len=self.config.get("head_max_len", labmod.DEFAULT_HEAD_MAX_LEN))

    def select_context(self, task: str, paths: list[str], root: str = "", *, skip_threshold: float = 0.95,
                       max_file_bytes: int = 262144, chunk_lines: int = 80, max_chunks: int = 64,
                       batch_size: int = 8) -> dict:
        try:
            backend = self.backend()
        except (ImportError, ValueError, OSError, RuntimeError):
            backend = None
        return select_file_context(task, paths, root=root or self.root, backend=backend,
                                   head_max_len=self.config.get("head_max_len", labmod.DEFAULT_HEAD_MAX_LEN),
                                   skip_threshold=skip_threshold, max_file_bytes=max_file_bytes,
                                   chunk_lines=chunk_lines, max_chunks=max_chunks, batch_size=batch_size)

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
        "with the outcome so the policy table can be tuned from evidence. Call `select_context` with the task "
        "and candidate paths before loading many files into context. It reads locally and returns recommended "
        "line ranges, never raw file content. Read those ranges with your normal file tools; incomplete "
        "analysis or classifier failure keeps candidates available. Explicit user requests and correctness "
        "can override a skip recommendation. Call `should_read_file` before reading "
        "a candidate file when its relevance is unclear. Supply the task, path, and any summary or excerpt already "
        "available. It recommends reading on uncertainty or Laya failure; it never opens the candidate file. "
        "Never calls a provider."))

    @server.tool()
    def route(task: str, phase: str = "work", budget: str = "default") -> dict:
        """Classify a task brief and pick the cheapest adequate model profile. phase: work|review."""
        return service.route(task, phase, budget)

    @server.tool()
    def should_read_file(task: str, path: str, summary: str = "", excerpt: str = "") -> dict:
        """Ask local Laya whether a file helps this task. Advisory only; never opens the file.

        Use a repository-relative path and context already known from search results, not a full-file read.
        A confident negative returns should_read=false. Uncertainty or unavailable Laya recommends reading.
        """
        return service.should_read_file(task, path, summary, excerpt)

    @server.tool()
    def select_context(task: str, paths: list[str], root: str = "", skip_threshold: float = 0.95,
                       max_file_bytes: int = 262144, chunk_lines: int = 80, max_chunks: int = 64,
                       batch_size: int = 8) -> dict:
        """Read up to 20 candidate text files locally and recommend paths and line ranges.

        Content stays local. Paths are relative to root, which defaults to the server's project root.
        Defaults require no selection configuration. Incomplete coverage, uncertainty, and Laya
        failures retain candidates. Recommendations are advisory; user-requested files remain readable.
        """
        return service.select_context(task, paths, root, skip_threshold=skip_threshold,
                                      max_file_bytes=max_file_bytes, chunk_lines=chunk_lines,
                                      max_chunks=max_chunks, batch_size=batch_size)

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
    parser.add_argument("--profiles", default=DEFAULT_PROFILES)
    parser.add_argument("--catalog", default=DEFAULT_CATALOG)
    parser.add_argument("--config")
    parser.add_argument("--records")
    parser.add_argument("--decisions")
    parser.add_argument("--backend", choices=("auto", "heuristic", "laya"), default="auto")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--root", help="default project root for local context selection")
    parser.add_argument("--selftest", action="store_true", help="instantiate the service and tools, print a route, exit")
    args = parser.parse_args(argv)
    try:
        service = Service(args.profiles, args.catalog, args.config, args.records, args.decisions,
                          args.backend, args.device, args.root)
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
