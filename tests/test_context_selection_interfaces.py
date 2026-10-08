"""Exercise local context selection through CLI, MCP, and the offline runtime."""
import asyncio
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape import cli, mcp_server  # noqa: E402


class ContentBackend:
    name = "laya"

    def __init__(self):
        self.states = []

    def predict(self, state, questions, head_max_len=None):
        self.states.append(state)
        relevant = "TOKEN_EXPIRY" in state["candidate_excerpt"]
        choice = "yes" if relevant else "no"
        return {"answers": {"relevance": {
            "choice": choice, "probabilities": {"yes": 0.99 if relevant else 0.01,
                                                  "no": 0.01 if relevant else 0.99},
            "answer_confidence": 0.99, "confidence": 0.9,
        }}, "usage": {"truncated": False}}


class ContextSelectionInterfaces(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        (self.root / "session.py").write_text("TOKEN_EXPIRY = 3600\nPRIVATE_LOCAL_CONTENT = True\n")
        (self.root / "theme.md").write_text("PRIVATE_PALETTE_CONTENT\nblue\n")

    def run_cli(self, args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["select-context", *args])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def test_cli_reads_multiple_candidates_locally_and_returns_only_ranges(self):
        backend = ContentBackend()
        with patch.object(cli, "LayaBackend", return_value=backend) as load:
            result = self.run_cli(["--task", "Fix expiry", "--root", str(self.root),
                                   "--path", "session.py", "--path", "theme.md", "--checkpoint", "/local/model"])
        load.assert_called_once_with("/local/model", device="cpu")
        selected, skipped = result["files"]
        self.assertTrue(selected["should_read"])
        self.assertEqual(selected["ranges"], [{"start_line": 1, "end_line": 2}])
        self.assertFalse(skipped["should_read"])
        self.assertNotIn("PRIVATE_LOCAL_CONTENT", json.dumps(result))
        self.assertNotIn("PRIVATE_PALETTE_CONTENT", json.dumps(result))
        self.assertTrue(any("TOKEN_EXPIRY" in state["candidate_excerpt"] for state in backend.states))

    def test_cli_accepts_task_stdin_config_and_optional_selection_settings(self):
        config = self.root / "taskshape.json"
        config.write_text(json.dumps({"version": 1, "checkpoint": "/local/model"}))
        backend = ContentBackend()
        with patch.object(cli, "LayaBackend", return_value=backend), patch.object(sys, "stdin", io.StringIO("Corrigir sessão")):
            result = self.run_cli(["--task-stdin", "--root", str(self.root), "--path", "session.py",
                                   "--config", str(config), "--chunk-lines", "1", "--max-chunks", "2",
                                   "--batch-size", "1", "--skip-threshold", "0.99"])
        self.assertTrue(result["files"][0]["should_read"])
        self.assertTrue(result["files"][0]["complete"])
        self.assertEqual(backend.states[0]["task"], "Corrigir sessão")

    def test_cli_without_checkpoint_is_conservative(self):
        result = self.run_cli(["--task", "Fix expiry", "--root", str(self.root), "--path", "session.py"])
        item = result["files"][0]
        self.assertTrue(item["should_read"])
        self.assertEqual(item["source"], "conservative-fallback")
        self.assertNotIn("PRIVATE_LOCAL_CONTENT", json.dumps(result))

    def test_mcp_reuses_backend_and_project_root_without_writing_audits(self):
        config = self.root / "taskshape.json"
        config.write_text(json.dumps({"version": 1, "checkpoint": "/local/model"}))
        audit = self.root / "decisions.jsonl"
        service = mcp_server.Service(ROOT / "catalog/profiles.example.json", ROOT / "catalog/models.json",
                                     config_path=config, decisions_path=audit, root=self.root)
        backend = ContentBackend()
        with patch.object(mcp_server, "LayaBackend", return_value=backend) as load:
            first = service.select_context("Fix expiry", ["session.py"])
            second = service.select_context("Fix expiry", ["theme.md"])
        load.assert_called_once()
        self.assertTrue(first["files"][0]["should_read"])
        self.assertFalse(second["files"][0]["should_read"])
        self.assertFalse(audit.exists())

    def test_mcp_backend_failure_retains_candidate_without_exception_text(self):
        service = mcp_server.Service(ROOT / "catalog/profiles.example.json", ROOT / "catalog/models.json",
                                     root=self.root)
        with patch.object(service, "backend", side_effect=RuntimeError("PRIVATE_EXCEPTION_CONTENT")):
            result = service.select_context("Fix expiry", ["session.py"])
        self.assertTrue(result["files"][0]["should_read"])
        self.assertNotIn("PRIVATE_EXCEPTION_CONTENT", json.dumps(result))

    @unittest.skipUnless(importlib.util.find_spec("mcp"), "optional MCP dependency is not installed")
    def test_registered_mcp_tool_needs_only_task_and_paths(self):
        service = mcp_server.Service(ROOT / "catalog/profiles.example.json", ROOT / "catalog/models.json",
                                     root=self.root)
        service._backend = ContentBackend()
        server = mcp_server.build_server(service)
        tools = asyncio.run(server.list_tools())
        tool = next(tool for tool in tools if tool.name == "select_context")
        self.assertEqual(set(tool.input_schema["required"]), {"task", "paths"})
        response = asyncio.run(server.call_tool("select_context", {"task": "Fix expiry", "paths": ["session.py"]}))
        self.assertFalse(response.is_error)
        self.assertTrue(json.loads(response.content[0].text)["files"][0]["should_read"])

    def test_offline_runtime_accepts_selection_operation_without_ml_dependencies(self):
        result = subprocess.run([sys.executable, "-I", str(ROOT / "runtime/classify.py"), str(self.root / "no-checkpoint")],
                                input=json.dumps({"operation": "select_context", "task": "Fix expiry",
                                                  "paths": ["session.py"], "root": str(self.root)}),
                                text=True, capture_output=True, timeout=20,
                                env={**os.environ, "TASKSHAPE_HOME": str(self.root / "home")})
        self.assertEqual(result.returncode, 0, result.stderr)
        selected = json.loads(result.stdout)["files"][0]
        self.assertTrue(selected["should_read"])
        self.assertEqual(selected["total_lines"], 2)
        self.assertNotIn("PRIVATE_LOCAL_CONTENT", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
