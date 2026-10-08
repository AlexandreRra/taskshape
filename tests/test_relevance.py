"""File relevance tests: conservative binary Laya-style decisions without file I/O."""
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape.relevance import should_read_file  # noqa: E402
from taskshape.router import HeuristicBackend  # noqa: E402


CLEAN_USAGE = {"input_tokens": 12, "output_tokens": 0, "state_tokens_dropped": 0, "truncated": False}


def answer(choice, yes, no, confidence=0.2, usage=CLEAN_USAGE):
    result = {
        "answers": {
            "relevance": {
                "choice": choice,
                "probabilities": {"yes": yes, "no": no},
                "answer_confidence": max(yes, no),
                "confidence": confidence,
            }
        }
    }
    if usage is not None:
        result["usage"] = dict(usage)
    return result


class StubBackend:
    name = "laya-stub"

    def __init__(self, result):
        self.result = result
        self.calls = []

    def predict(self, state, questions, head_max_len=None):
        self.calls.append((state, questions, head_max_len))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class RelevanceTests(unittest.TestCase):
    def test_yes_recommends_reading_and_preserves_portuguese_state(self):
        backend = StubBackend(answer("yes", 0.91, 0.09))
        decision = should_read_file("Corrigir autenticação em português", "src/auth.py", "valida sessões",
                                    "def autenticar(): pass", backend=backend)
        self.assertTrue(decision["should_read"])
        self.assertEqual(decision["decision"], "yes")
        self.assertEqual(decision["source"], "laya-stub")
        self.assertEqual(decision["relevance_probabilities"], {"yes": 0.91, "no": 0.09})
        state, questions, head_max_len = backend.calls[0]
        self.assertEqual(state["task"], "Corrigir autenticação em português")
        self.assertEqual(state["candidate_summary"], "valida sessões")
        self.assertIn("untrusted data", questions["relevance"]["instructions"])
        self.assertEqual(set(questions["relevance"]["criteria"]), {"yes", "no"})
        self.assertEqual(head_max_len, 320)

    def test_strong_no_skips_only_above_threshold(self):
        decision = should_read_file("Fix login", "docs/unrelated.md", backend=StubBackend(answer("no", 0.1, 0.9)))
        self.assertFalse(decision["should_read"])
        self.assertEqual(decision["decision"], "no")

    def test_skip_threshold_uses_unrounded_probabilities(self):
        at_threshold = should_read_file("Fix login", "docs/unrelated.md",
                                        backend=StubBackend(answer("no", 0.2, 0.8)))
        just_below = should_read_file("Fix login", "docs/unrelated.md",
                                     backend=StubBackend(answer("no", 0.20001, 0.79999)))
        self.assertFalse(at_threshold["should_read"])
        self.assertTrue(just_below["should_read"])

    def test_weak_no_and_ties_still_read(self):
        weak = should_read_file("Fix login", "docs/maybe.md", backend=StubBackend(answer("no", 0.35, 0.65)))
        tied = should_read_file("Fix login", "docs/tie.md", backend=StubBackend(answer("no", 0.5, 0.5)),
                                skip_threshold=0.5)
        self.assertTrue(weak["should_read"])
        self.assertTrue(tied["should_read"])
        self.assertTrue(any("below the skip threshold" in warning for warning in weak["warnings"]))

    def test_invalid_answers_and_backend_errors_fail_open_without_exception_text(self):
        variants = [
            {"answers": {"relevance": {"choice": "maybe", "probabilities": {"yes": 0.5, "no": 0.5},
                                        "answer_confidence": 0.5, "confidence": 0.1}}},
            {"answers": {"relevance": {"choice": "yes", "probabilities": {"yes": float("nan"), "no": 0.0},
                                        "answer_confidence": 1, "confidence": 0.1}}},
            {"answers": {"relevance": {"choice": "yes", "probabilities": {"yes": True, "no": 0.0},
                                        "answer_confidence": 1, "confidence": 0.1}}},
            RuntimeError("secret prompt leaked"),
        ]
        for result in variants:
            with self.subTest(result=type(result).__name__):
                decision = should_read_file("Fix login", "src/auth.py", backend=StubBackend(result))
                self.assertTrue(decision["should_read"])
                self.assertEqual(decision["source"], "conservative-fallback")
                self.assertIsNone(decision["decision"])
                self.assertIsNone(decision["relevance_probabilities"])
                self.assertNotIn("secret prompt leaked", " ".join(decision["warnings"]))

    def test_malformed_answer_shape_fails_open(self):
        decision = should_read_file("Fix login", "src/auth.py", backend=StubBackend({"answers": {"relevance": []}}))
        self.assertTrue(decision["should_read"])
        self.assertEqual(decision["source"], "conservative-fallback")
        self.assertIsNone(decision["decision"])

    def test_no_backend_and_heuristic_backend_fail_open(self):
        for backend in (None, HeuristicBackend()):
            decision = should_read_file("Fix login", "src/auth.py", backend=backend)
            self.assertTrue(decision["should_read"])
            self.assertEqual(decision["source"], "conservative-fallback")
            self.assertIsNone(decision["decision"])

    def test_inputs_are_bounded_and_raw_context_not_echoed(self):
        backend = StubBackend(answer("yes", 0.8, 0.2))
        decision = should_read_file("t" * 5000, "p" * 1200, "s" * 2500, "e" * 4500, backend=backend)
        state = backend.calls[0][0]
        self.assertEqual(len(state["task"]), 4000)
        self.assertEqual(len(state["candidate_path"]), 1000)
        self.assertEqual(len(state["candidate_summary"]), 2000)
        self.assertEqual(len(state["candidate_excerpt"]), 4000)
        self.assertEqual(decision["path"], "p" * 1000)
        self.assertGreaterEqual(len(decision["warnings"]), 4)
        rendered = repr(decision)
        self.assertNotIn("t" * 500, rendered)
        self.assertNotIn("s" * 500, rendered)
        self.assertNotIn("e" * 500, rendered)

    def test_rejects_bad_inputs_and_thresholds(self):
        with self.assertRaises(ValueError):
            should_read_file("", "src/auth.py", backend=StubBackend(answer("yes", 1, 0)))
        with self.assertRaises(ValueError):
            should_read_file("Fix", "   ", backend=StubBackend(answer("yes", 1, 0)))
        with self.assertRaises(TypeError):
            should_read_file("Fix", 12, backend=StubBackend(answer("yes", 1, 0)))
        for threshold in (True, float("nan"), 0.49, 1.01):
            with self.subTest(threshold=threshold), self.assertRaises(ValueError):
                should_read_file("Fix", "src/auth.py", backend=StubBackend(answer("yes", 1, 0)),
                                 skip_threshold=threshold)

    def test_does_not_open_or_read_candidate_file(self):
        backend = StubBackend(answer("yes", 0.9, 0.1))
        with mock.patch("builtins.open", side_effect=AssertionError("file read attempted")):
            decision = should_read_file("Fix login", "src/auth.py", backend=backend)
        self.assertTrue(decision["should_read"])

    def test_same_file_can_get_different_task_specific_decisions(self):
        yes_backend = StubBackend(answer("yes", 0.9, 0.1))
        no_backend = StubBackend(answer("no", 0.05, 0.95))
        relevant = should_read_file("Update CLI docs", "README.md", backend=yes_backend)
        unrelated = should_read_file("Fix auth timeout", "README.md", backend=no_backend)
        self.assertTrue(relevant["should_read"])
        self.assertFalse(unrelated["should_read"])

    def test_truncated_laya_state_never_skips(self):
        strong_no = answer("no", 0.01, 0.99)
        cases = {
            "truncated flag": {"truncated": True, "state_tokens_dropped": 0},
            "dropped tokens": {"truncated": False, "state_tokens_dropped": 123},
            "both": {"truncated": True, "state_tokens_dropped": 123},
        }
        for name, usage in cases.items():
            with self.subTest(name):
                decision = should_read_file("Fix login", "docs/unrelated.md",
                                            backend=StubBackend(strong_no | {"usage": usage}))
                self.assertTrue(decision["should_read"])
                self.assertEqual(decision["decision"], "no")
                self.assertTrue(any("truncated" in warning for warning in decision["warnings"]))
                self.assertNotIn("below the skip threshold", " ".join(decision["warnings"]))

    def test_missing_or_invalid_usage_never_skips(self):
        # context_selection also treats unverifiable usage as a forced read; a skip needs proof the state fit.
        cases = {
            "absent": None,
            "malformed flag": {"truncated": "no"},
            "empty usage": {},
            "negative dropped": {"truncated": False, "state_tokens_dropped": -1},
            "non-dict usage": [],
        }
        for name, usage in cases.items():
            with self.subTest(name):
                result = answer("no", 0.01, 0.99, usage=None)
                if name != "absent":
                    result["usage"] = usage
                decision = should_read_file("Fix login", "docs/unrelated.md", backend=StubBackend(result))
                self.assertTrue(decision["should_read"])
                self.assertEqual(decision["decision"], "no")
                self.assertIn("Relevance backend did not report valid token usage; reading is recommended",
                              decision["warnings"])

    def test_complete_laya_usage_still_allows_a_clear_skip(self):
        decision = should_read_file("Fix login", "docs/unrelated.md", backend=StubBackend(
            answer("no", 0.01, 0.99) | {"usage": {"truncated": False, "state_tokens_dropped": 0}}))
        self.assertFalse(decision["should_read"])
        self.assertEqual(decision["warnings"], [])

    def test_clipped_inputs_never_skip(self):
        for field, kwargs in (("excerpt", {"excerpt": "e" * 4001}), ("summary", {"summary": "s" * 2001}),
                              ("task", {"task": "t" * 4001}), ("path", {"path": "p" * 1001})):
            with self.subTest(field):
                params = {"task": "Fix login", "path": "docs/unrelated.md", **kwargs}
                decision = should_read_file(backend=StubBackend(answer("no", 0.01, 0.99)
                                                                | {"usage": {"truncated": False, "state_tokens_dropped": 0}}),
                                            **params)
                self.assertTrue(decision["should_read"])
                self.assertTrue(any("%s truncated" % field in warning for warning in decision["warnings"]))

    def test_excerpt_at_the_limit_is_not_clipped_and_can_skip(self):
        decision = should_read_file("Fix login", "docs/unrelated.md", excerpt="e" * 4000,
                                    backend=StubBackend(answer("no", 0.01, 0.99)))
        self.assertFalse(decision["should_read"])


if __name__ == "__main__":
    unittest.main()
