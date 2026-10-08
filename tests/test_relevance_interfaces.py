"""Exercise the file-relevance query through the CLI and MCP interfaces."""
import asyncio
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape import cli, mcp_server  # noqa: E402


class Backend:
    name = "laya"

    def predict(self, state, questions, head_max_len=None):
        self.state = state
        return {"answers": {"relevance": {"choice": "no", "probabilities": {"yes": 0.1, "no": 0.9},
                                           "answer_confidence": 0.9, "confidence": 0.5}},
                "usage": {"truncated": False, "state_tokens_dropped": 0}}


class CliRelevanceTests(unittest.TestCase):
    def run_cli(self, args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["should-read-file", *args])
        self.assertEqual(code, 0)
        return json.loads(out.getvalue())

    def test_local_checkpoint_and_file_context_reach_the_binary_classifier(self):
        backend = Backend()
        with patch.object(cli, "LayaBackend", return_value=backend) as load:
            result = self.run_cli(["--task", "Fix login", "--path", "docs/billing.md", "--summary", "Billing guide",
                                   "--excerpt", "Known heading", "--checkpoint", "/local/model"])
        load.assert_called_once_with("/local/model", device="cpu")
        self.assertFalse(result["should_read"])
        self.assertEqual(backend.state["candidate_excerpt"], "Known heading")
        self.assertNotIn("Known heading", json.dumps(result))

    def test_task_stdin_and_configured_checkpoint(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            config.write_text(json.dumps({"version": 1, "checkpoint": "/local/model"}))
            backend = Backend()
            with patch.object(cli, "LayaBackend", return_value=backend), patch.object(sys, "stdin", io.StringIO("Corrigir login")):
                result = self.run_cli(["--task-stdin", "--path", "billing.py", "--config", str(config)])
        self.assertEqual(backend.state["task"], "Corrigir login")
        self.assertEqual(result["source"], "laya")

    def test_missing_or_broken_laya_recommends_reading_without_leaking_errors(self):
        result = self.run_cli(["--task", "Fix login", "--path", "missing.py"])
        self.assertTrue(result["should_read"])
        self.assertEqual(result["source"], "conservative-fallback")
        with patch.object(cli, "LayaBackend", side_effect=RuntimeError("PRIVATE PROMPT")):
            result = self.run_cli(["--task", "Fix login", "--path", "missing.py", "--checkpoint", "/missing"])
        self.assertTrue(result["should_read"])
        self.assertNotIn("PRIVATE PROMPT", json.dumps(result))

    def test_empty_task_is_an_input_error(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = cli.main(["should-read-file", "--task", "", "--path", "x.py"])
        self.assertEqual(code, 1)
        self.assertIn("task must be nonempty", err.getvalue())


class McpRelevanceTests(unittest.TestCase):
    def service(self, **kwargs):
        return mcp_server.Service(ROOT / "catalog/profiles.example.json", ROOT / "catalog/models.json", **kwargs)

    def test_query_reuses_backend_and_does_not_write_routing_audits(self):
        with tempfile.TemporaryDirectory() as folder:
            audit = Path(folder) / "decisions.jsonl"
            service = self.service(decisions_path=audit)
            service._backend = Backend()
            result = service.should_read_file("Fix login", "billing.py", "Billing implementation")
            self.assertFalse(result["should_read"])
            self.assertEqual(service._backend.state["candidate_summary"], "Billing implementation")
            self.assertFalse(audit.exists())

    def test_heuristic_and_unavailable_laya_are_explicit_conservative_fallbacks(self):
        for service in (self.service(backend="heuristic"), self.service(backend="laya")):
            result = service.should_read_file("Fix login", "auth.py")
            self.assertTrue(result["should_read"])
            self.assertEqual(result["source"], "conservative-fallback")

    @unittest.skipUnless(importlib.util.find_spec("mcp"), "optional MCP dependency is not installed")
    def test_registered_mcp_tool_is_discoverable_and_callable(self):
        service = self.service()
        service._backend = Backend()
        server = mcp_server.build_server(service)
        tools = asyncio.run(server.list_tools())
        tool = next(t for t in tools if t.name == "should_read_file")
        self.assertEqual(set(tool.input_schema["required"]), {"task", "path"})
        response = asyncio.run(server.call_tool("should_read_file", {"task": "Fix login", "path": "billing.py"}))
        self.assertFalse(response.is_error)
        self.assertFalse(json.loads(response.content[0].text)["should_read"])


if __name__ == "__main__":
    unittest.main()
