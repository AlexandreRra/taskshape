"""Regressions for the 2026-10-08 audit findings in the Python core (rubric, records, router, policy, catalog, cli)."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape import catalog, cli, policy, records, router, rubric  # noqa: E402

PROFILES = ROOT / "catalog/profiles.example.json"


class RubricCueTests(unittest.TestCase):
    def test_broad_cues_do_not_make_unrelated_words_coupled(self):
        for text in ("Author the changelog entry", "Update the lockfile", "Save the report as markdown"):
            with self.subTest(text=text):
                self.assertNotEqual(rubric.classify(text), "coupled")

    def test_real_cues_still_make_coupled(self):
        for text in ("Fix the authentication flow", "Check authorization for the admin route", "The job locks the table",
                     "Fix the auth bug", "Fix OAuth login redirect", "Fix the unauthorized 401 error", "OAuth2 flow",
                     "authn token refresh", "Review authz rules", "Fix the unauthenticated path", "Handle authorisation errors"):
            with self.subTest(text=text):
                self.assertEqual(rubric.classify(text), "coupled")

    def test_source_and_bare_see_do_not_erase_the_rest_of_the_clause(self):
        self.assertEqual(rubric.classify("Look at the source and fix the race condition"), "coupled")
        self.assertEqual(rubric.classify("Check the following and fix the deadlock"), "coupled")

    def test_real_citations_are_still_stripped(self):
        self.assertEqual(rubric.classify("Fix the label; per the migration guide section 3"), "routine")
        self.assertEqual(rubric.classify("Fix the label; see the schema doc"), "routine")
        self.assertEqual(rubric.classify("Fix the label; conforms to RFC-7231 and §4.2"), "routine")

    def test_a_citation_removes_only_the_reference_not_the_rest_of_the_sentence(self):
        for text in ("Per the ticket fix the deadlock", "See the spec and fix the race condition",
                     "Implement per the RFC-7 the schema migration", "Applies RFC-7 but the migration must be idempotent"):
            with self.subTest(text=text):
                self.assertEqual(rubric.classify(text), "coupled")
        self.assertEqual(rubric.classify("Author the changelog entry"), "routine")


class CliOutputEncodingTests(unittest.TestCase):
    def run_cli(self, *args, encoding="cp1252", stdin=None):
        import os
        import subprocess
        env = dict(os.environ, PYTHONIOENCODING=encoding, PYTHONPATH=str(ROOT / "src"))
        return subprocess.run([sys.executable, "-B", "-m", "taskshape.cli", *args], capture_output=True, env=env, input=stdin, timeout=30)

    def test_stdout_is_utf8_even_when_the_console_encoding_cannot_represent_the_text(self):
        task = "исправить ошибку"
        result = self.run_cli("route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task", task)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(json.loads(result.stdout.decode("utf-8"))["task"], task)

    def test_stdin_and_stdout_round_trip_utf8_under_cp1252(self):
        task = "Área de login: corrigir o Índice — исправить"
        result = self.run_cli("route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task-stdin", stdin=task.encode("utf-8"))
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(json.loads(result.stdout.decode("utf-8"))["task"], task)

    def test_error_messages_are_utf8_too(self):
        result = self.run_cli("route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task", "x", "--budget", "исправить")
        self.assertEqual(result.returncode, 1)
        self.assertIn("исправить", result.stderr.decode("utf-8"))


class ReportTests(unittest.TestCase):
    def test_unknown_acceptance_is_reported_apart_and_not_counted_as_rejection(self):
        profiles = catalog.load_profiles(PROFILES)["profiles"]
        rows = [{"shape": "demanding", "profile": "sonnet-high", "model": "m", "effort": "high", "accepted": None} for _ in range(12)]
        rows += [{"shape": "demanding", "profile": "sonnet-high", "model": "m", "effort": "high", "accepted": True} for _ in range(12)]
        cell = records.report(rows, profiles)["cells"]["demanding/sonnet-high"]
        self.assertEqual((cell["n"], cell["unknown"], cell["acceptance"]), (24, 12, 1.0))

    def test_only_unknown_outcomes_never_support_a_suggestion(self):
        profiles = catalog.load_profiles(PROFILES)["profiles"]
        rows = [{"shape": "demanding", "profile": "sonnet-high", "model": "m", "effort": "high", "accepted": None} for _ in range(20)]
        result = records.report(rows, profiles)
        self.assertIsNone(result["cells"]["demanding/sonnet-high"]["acceptance"])
        self.assertEqual(result["suggestions"], {})

    def test_non_boolean_accepted_values_are_unknown(self):
        profiles = catalog.load_profiles(PROFILES)["profiles"]
        rows = [{"shape": "demanding", "profile": "sonnet-high", "model": "m", "effort": "high", "accepted": value}
                for value in ("yes", 1, [], True)]
        cell = records.report(rows, profiles, min_samples=1)["cells"]["demanding/sonnet-high"]
        self.assertEqual((cell["unknown"], cell["acceptance"]), (3, 1.0))


class UnattributedOutcomeTests(unittest.TestCase):
    def test_outcomes_without_a_profile_are_counted_apart_and_never_credit_the_suggestion(self):
        profiles = catalog.load_profiles(PROFILES)["profiles"]
        base = {"shape": "demanding", "model": "inherited", "effort": "default", "accepted": True}
        rows = [dict(base, profile=None, suggested_profile="sonnet-high") for _ in range(12)]
        rows.append(dict(base, profile="sol-high", model="m", effort="high"))
        rows.append({k: v for k, v in base.items()} | {"profile": ""})
        result = records.report(rows, profiles, min_samples=1)
        self.assertEqual(result["unattributed"], 13)
        self.assertEqual(set(result["cells"]), {"demanding/sol-high"})
        self.assertNotIn("demanding/None", result["cells"])
        self.assertEqual(result["suggestions"]["demanding"]["cheapest_profile_holding_up"], "sol-high")

    def test_only_unattributed_outcomes_produce_no_cells_or_suggestions(self):
        profiles = catalog.load_profiles(PROFILES)["profiles"]
        rows = [{"shape": "demanding", "profile": None, "suggested_profile": "sonnet-high", "model": "inherited",
                 "effort": "default", "accepted": True} for _ in range(20)]
        result = records.report(rows, profiles)
        self.assertEqual((result["cells"], result["suggestions"], result["unattributed"]), ({}, {}, 20))


class UnderProvisionedTieTests(unittest.TestCase):
    def test_equal_capability_and_cost_pick_the_lowest_id(self):
        profiles = [{"id": "b-high", "model": "m", "effort": "high", "capability": 2, "cost_tier": 1},
                    {"id": "a-high", "model": "m", "effort": "high", "capability": 2, "cost_tier": 1}]
        choice = policy.choose("architecture", profiles)
        self.assertEqual(choice.profile["id"], "a-high")
        self.assertTrue(choice.warnings)

    def test_equal_capability_prefers_the_cheaper_profile(self):
        profiles = [{"id": "a", "model": "m", "effort": "high", "capability": 2, "cost_tier": 2},
                    {"id": "z", "model": "m", "effort": "high", "capability": 2, "cost_tier": 1}]
        self.assertEqual(policy.choose("architecture", profiles).profile["id"], "z")


class ProfileEffortTests(unittest.TestCase):
    def load(self, **overrides):
        profile = {"id": "a", "model": "m", "capability": 1, "cost_tier": 1}
        profile.update(overrides)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"version": 1, "profiles": [profile]}, handle)
        self.addCleanup(Path(handle.name).unlink)
        return catalog.load_profiles(handle.name)["profiles"][0]

    def test_missing_effort_defaults_like_the_typescript_loader(self):
        self.assertEqual(self.load()["effort"], "default")
        self.assertEqual(self.load(effort="high")["effort"], "high")

    def test_effort_must_be_a_non_empty_string(self):
        for bad in (None, 5, "", True):
            with self.subTest(effort=bad), self.assertRaises(ValueError):
                self.load(effort=bad)

    def test_fractional_numeric_fields_are_refused(self):
        for key in ("capability", "cost_tier"):
            for bad in (2.5, 1.0, "2", True):
                with self.subTest(key=key, value=bad), self.assertRaises(ValueError):
                    self.load(**{key: bad})

    def test_route_works_with_a_profile_that_has_no_effort(self):
        decision = router.route("Fix the typo in README", [{"id": "a", "model": "m", "capability": 4, "cost_tier": 1}])
        self.assertEqual(decision.effort, "default")


class RouterHardeningTests(unittest.TestCase):
    def setUp(self):
        self.profiles = catalog.load_profiles(PROFILES)["profiles"]

    def test_decision_hash_covers_the_full_task_and_joins_with_the_outcome(self):
        task = "Fix the typo in README. " + "padding " * 100
        self.assertGreater(len(task), 500)
        decision = router.route(task, self.profiles)
        self.assertEqual(len(decision.task), 500)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        decisions = Path(temp.name) / "decisions.jsonl"
        outcomes = Path(temp.name) / "outcomes.jsonl"
        decision_row = records.append_decision(decisions, decision.as_dict())
        outcome_row = records.record(outcomes, decision.shape, decision.profile, decision.model, decision.effort, True, task=task)
        self.assertEqual(decision_row["task_sha256"], outcome_row["task_sha256"])
        self.assertNotEqual(decision_row["task_sha256"], router.task_hash(decision.task))

    def test_audit_row_without_a_precomputed_hash_still_hashes_the_task(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        row = records.append_decision(Path(temp.name) / "d.jsonl", {"task": "x", "phase": "work"})
        self.assertEqual(row["task_sha256"], router.task_hash("x"))

    def test_backend_exception_text_never_reaches_the_audit_log(self):
        secret = "SECRET-CUSTOMER-PLAN-4711"

        class Leaky:
            def predict(self, state, questions, head_max_len=None):
                raise RuntimeError("could not classify: " + state["task"])

        decision = router.route("Fix the typo in README " + secret, self.profiles, backend=Leaky())
        self.assertEqual(decision.source, "heuristic-fallback")
        self.assertTrue(any("RuntimeError" in w for w in decision.warnings))
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "decisions.jsonl"
        records.append_decision(path, decision.as_dict())
        self.assertNotIn(secret, path.read_text())
        self.assertNotIn(secret, json.dumps(decision.warnings))

    def test_malformed_backend_responses_fall_back_to_the_rubric(self):
        malformed = [{"answers": {"shape": []}}, {"answers": {"shape": "routine"}}, {"answers": []}, {"answers": "x"},
                     {"answers": None}, {"answers": {}}, {}, None, [], "x", {"answers": {"shape": {"probabilities": []}}},
                     {"answers": {"shape": {"choice": [], "probabilities": {}}}}]
        for response in malformed:
            class Bad:
                def predict(self, state, questions, head_max_len=None, response=response):
                    return response

            with self.subTest(response=response):
                decision = router.route("Fix the typo in README", self.profiles, backend=Bad())
                self.assertEqual((decision.source, decision.shape), ("heuristic-fallback", "routine"))
                self.assertTrue(any("rubric used" in w for w in decision.warnings))

    def test_validate_answer_rejects_non_objects(self):
        with self.assertRaises(ValueError):
            router.validate_answer([], ["routine"])


class StateUsageErrorTests(unittest.TestCase):
    @staticmethod
    def backend(agent):
        backend = object.__new__(router.LayaBackend)
        backend.agent = agent
        return backend

    def test_private_api_failure_is_a_state_usage_error_that_hides_the_task(self):
        class Broken:
            def _check_question(self, qid, question):
                raise AttributeError("no _encode_state for SECRET-TASK")

        questions = {"q": {"type": "choice", "criteria": {"a": "x"}}}
        with self.assertRaises(router.StateUsageError) as caught:
            self.backend(Broken()).state_usage({"task": "SECRET-TASK"}, questions)
        self.assertIsInstance(caught.exception, RuntimeError)  # callers that catch RuntimeError keep working
        self.assertNotIn("SECRET-TASK", str(caught.exception))
        self.assertIn("AttributeError", str(caught.exception))

    def test_malformed_stats_are_also_a_state_usage_error(self):
        class Odd:
            def _check_question(self, qid, question):
                pass

            def _to_internal(self, question):
                return question

            def _encode_state(self, state, ids, internal, head_max_len=None):
                return [{"state_stats": {}}]

        with self.assertRaises(router.StateUsageError):
            self.backend(Odd()).state_usage({"task": "t"}, {"q": {}})

    def test_working_accounting_reports_truncation_not_an_error(self):
        class Fine:
            def _check_question(self, qid, question):
                pass

            def _to_internal(self, question):
                return question

            def _encode_state(self, state, ids, internal, head_max_len=None):
                return [{"state_stats": {"state_tokens": 10, "state_tokens_dropped": 3, "truncated": True}}]

        usage = self.backend(Fine()).state_usage({"task": "t"}, {"q": {}})
        self.assertEqual((usage["truncated"], usage["state_tokens_dropped"], usage["truncated_questions"]), (True, 3, ["q"]))


class StdinUtf8Tests(unittest.TestCase):
    TASK = "Área de login: corrigir o Índice da sessão"

    def with_stdin(self, encoding):
        # A console locale that is not UTF-8: the text layer would garble the bytes the caller sent.
        return io.TextIOWrapper(io.BytesIO(self.TASK.encode("utf-8")), encoding=encoding)

    def test_stdin_is_decoded_as_utf8_whatever_the_text_layer_says(self):
        original = sys.stdin
        sys.stdin = self.with_stdin("cp1252")
        try:
            self.assertEqual(cli._read_stdin(), self.TASK)
        finally:
            sys.stdin = original

    def test_route_task_stdin_hashes_the_exact_utf8_text(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        log = Path(temp.name) / "decisions.jsonl"
        original = sys.stdin
        sys.stdin = self.with_stdin("cp1252")
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                code = cli.main(["route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task-stdin", "--log", str(log)])
        finally:
            sys.stdin = original
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(log.read_text())["task_sha256"], router.task_hash(self.TASK))


if __name__ == "__main__":
    unittest.main()
