from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape import context_selection  # noqa: E402
from taskshape.context_selection import CONTEXT_SELECTION_WARNINGS, select_context  # noqa: E402


def answer(choice, yes, no, truncated=False):
    return {
        "answers": {
            "relevance": {
                "choice": choice,
                "probabilities": {"yes": yes, "no": no},
                "answer_confidence": max(yes, no),
                "confidence": 0.5,
            }
        },
        "usage": {
            "input_tokens": 12,
            "output_tokens": 0,
            "state_tokens_dropped": 1 if truncated else 0,
            "truncated": truncated,
        },
    }


class BatchBackend:
    name = "laya-stub"

    def __init__(self, choices=None, truncate_states=None):
        self.choices = choices if choices is not None and not isinstance(choices, list) else list(choices or [])
        self.truncate_states = truncate_states or (lambda state: False)
        self.batch_calls = []
        self.usage_calls = []
        self.served = 0

    def state_usage(self, state, questions, head_max_len=None):
        self.usage_calls.append((state, questions, head_max_len))
        truncated = self.truncate_states(state)
        return {"state_tokens": 100, "state_tokens_dropped": 1 if truncated else 0, "truncated": truncated}

    def predict_batch(self, states, questions, head_max_len=None, batch_size=None):
        self.batch_calls.append((states, questions, head_max_len, batch_size))
        if not isinstance(self.choices, list):
            return self.choices
        results = []
        for index, _state in enumerate(states, start=self.served):
            spec = self.choices[index] if index < len(self.choices) else ("no", 0.02, 0.98, False)
            results.append(spec if isinstance(spec, dict) else answer(*spec))
        self.served += len(states)
        return results


class ContextSelectionTests(unittest.TestCase):
    def test_reads_locally_returns_ranges_and_never_echoes_raw_content(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "src" / "auth.py"
            target.parent.mkdir()
            secret = "PRIVATE_IMPLEMENTATION_TOKEN"
            target.write_text("def login():\n    pass\n%s\n" % secret)

            result = select_context("Fix login", ["src/auth.py"], root=str(root),
                                    backend=BatchBackend([("yes", 0.93, 0.07, False)]),
                                    chunk_lines=10)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 3}])
        self.assertEqual(result["files"][0]["source"], "laya")
        self.assertNotIn(secret, repr(result))

    def test_merges_adjacent_relevant_ranges_and_keeps_late_relevance(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "module.py"
            path.write_text("\n".join("line %d" % i for i in range(1, 7)))
            backend = BatchBackend([
                ("no", 0.01, 0.99, False),
                ("yes", 0.90, 0.10, False),
                ("yes", 0.91, 0.09, False),
            ])

            result = select_context("Fix late behavior", ["module.py"], root=str(root),
                                    backend=backend, chunk_lines=2)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 3, "end_line": 6}])
        self.assertEqual(sum(len(call[0]) for call in backend.batch_calls), 3)

    def test_all_strong_no_skips_but_weak_no_fails_open(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("alpha\nbeta\n")
            strong = select_context("Fix login", ["a.txt"], root=str(root),
                                    backend=BatchBackend([("no", 0.01, 0.99, False)]),
                                    chunk_lines=10)
            weak = select_context("Fix login", ["a.txt"], root=str(root),
                                  backend=BatchBackend([("no", 0.10, 0.90, False)]),
                                  chunk_lines=10)

        self.assertFalse(strong["files"][0]["should_read"])
        self.assertEqual(strong["files"][0]["ranges"], [])
        self.assertTrue(weak["files"][0]["should_read"])
        self.assertEqual(weak["files"][0]["ranges"], [{"start_line": 1, "end_line": 2}])

    def test_missing_binary_oversize_and_symlink_escape_are_conservative(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            root = Path(folder)
            (root / "binary.bin").write_bytes(b"abc\x00def")
            (root / "large.txt").write_text("0123456789")
            external = Path(outside) / "external.txt"
            external.write_text("outside")
            (root / "escape.txt").symlink_to(external)

            # binary.bin (7 bytes) fits the default read limit, so only NUL detection can reject it.
            binary = select_context("Fix login", ["binary.bin"], root=str(root), backend=BatchBackend())
            result = select_context("Fix login", ["missing.py", "large.txt", "escape.txt"],
                                    root=str(root), backend=BatchBackend(), max_file_bytes=4)

        self.assertIn("file appears to be binary; reading is recommended", binary["files"][0]["warnings"])
        files = binary["files"] + result["files"]
        self.assertEqual([file["source"] for file in files], ["conservative-fallback"] * 4)
        self.assertTrue(all(file["should_read"] for file in files))
        self.assertTrue(all(file["complete"] is False for file in files))
        self.assertTrue(all(file["ranges"] == [] for file in files))
        self.assertIn("file exceeds the local read limit; reading is recommended", result["files"][1]["warnings"])
        self.assertIn("path escapes the project root; reading is recommended", result["files"][2]["warnings"])

    def test_symlink_inside_root_is_analyzed_and_keeps_requested_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sub = root / "sub"
            sub.mkdir()
            (sub / "inside.txt").write_text("inside\nmore\n")
            (root / "inside-link.txt").symlink_to(sub / "inside.txt")
            backend = BatchBackend([("yes", 0.95, 0.05, False)])

            result = select_context("Fix login", ["inside-link.txt"], root=str(root), backend=backend)

        item = result["files"][0]
        self.assertEqual(item["path"], "inside-link.txt")
        self.assertEqual(item["source"], "laya")
        self.assertTrue(item["complete"])
        self.assertEqual(item["ranges"], [{"start_line": 1, "end_line": 2}])
        self.assertEqual(item["total_lines"], 2)

    def test_token_overflow_splits_chunks_before_inference(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "fit.txt").write_text("one\ntwo\nthree\nfour\n")
            backend = BatchBackend(
                [("no", 0.01, 0.99, False)] * 4,
                truncate_states=lambda state: state["candidate_range"] == "1-4",
            )

            result = select_context("Fix login", ["fit.txt"], root=str(root),
                                    backend=backend, chunk_lines=4)

        self.assertFalse(result["files"][0]["should_read"])
        self.assertEqual(len(backend.batch_calls[0][0]), 2)
        self.assertGreaterEqual(len(backend.usage_calls), 3)

    def test_single_line_token_overflow_fails_open(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "huge.txt").write_text("x\n")
            backend = BatchBackend(truncate_states=lambda _state: True)

            result = select_context("Fix login", ["huge.txt"], root=str(root), backend=backend)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["source"], "conservative-fallback")
        self.assertEqual(result["files"][0]["ranges"], [])
        self.assertFalse(backend.batch_calls)

    def test_global_chunk_budget_marks_uncovered_ranges_for_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a1\na2\na3\na4\n")
            (root / "b.txt").write_text("b1\nb2\n")
            backend = BatchBackend([("no", 0.01, 0.99, False)] * 2)

            result = select_context("Fix login", ["a.txt", "b.txt"], root=str(root),
                                    backend=backend, chunk_lines=2, max_chunks=1)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertFalse(result["files"][0]["complete"])
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 4}])
        self.assertTrue(result["files"][1]["should_read"])
        self.assertFalse(result["files"][1]["complete"])
        self.assertEqual(result["files"][1]["ranges"], [{"start_line": 1, "end_line": 2}])
        self.assertFalse(backend.batch_calls)

    def test_partial_budget_with_relevant_first_chunk_keeps_whole_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("important\nother\n")
            backend = BatchBackend([("yes", 0.99, 0.01, False)])

            result = select_context("Fix important", ["a.txt"], root=str(root),
                                    backend=backend, chunk_lines=1, max_chunks=1)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertFalse(result["files"][0]["complete"])
        self.assertEqual(result["files"][0]["source"], "conservative-fallback")
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 2}])
        self.assertFalse(backend.batch_calls)

    def test_batch_size_and_usage_are_passed_to_backend(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\n")
            backend = BatchBackend([("no", 0.01, 0.99, False)])

            select_context("Fix login", ["a.txt"], root=str(root), backend=backend,
                           head_max_len=123, batch_size=7)

        self.assertEqual(backend.batch_calls[0][2:], (123, 7))
        self.assertEqual(backend.usage_calls[0][2], 123)

    def test_missing_backend_reads_metadata_and_recommends_whole_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\n")

            result = select_context("Fix login", ["a.txt"], root=str(root), backend=None)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["source"], "conservative-fallback")
        self.assertEqual(result["files"][0]["total_lines"], 2)
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 2}])

    def test_fallback_empty_file_still_recommends_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "empty.txt").write_text("")

            result = select_context("Fix login", ["empty.txt"], root=str(root), backend=None)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["source"], "conservative-fallback")
        self.assertEqual(result["files"][0]["ranges"], [])

    def test_preserves_requested_path_in_output_and_laya_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "file.txt").write_text("content\n")
            requested = "./file.txt"
            backend = BatchBackend([("yes", 0.99, 0.01, False)])

            result = select_context("Fix content", [requested], root=str(root), backend=backend)

        self.assertEqual(result["files"][0]["path"], requested)
        self.assertEqual(backend.batch_calls[0][0][0]["candidate_path"], requested)

    def test_malformed_result_and_usage_fail_open_per_file(self):
        bad_results = [
            {},
            {"answers": {"relevance": []}, "usage": {"truncated": False}},
            answer("no", 0.01, 0.99, truncated=False) | {"usage": []},
            answer("no", 0.01, 0.99, truncated=False) | {"usage": {}},
            answer("no", 0.01, 0.99, truncated=False) | {"usage": {"truncated": False, "state_tokens_dropped": float("nan")}},
            answer("no", 0.01, 0.99, truncated=False) | {"usage": {"truncated": False, "state_tokens_dropped": -1}},
        ]
        for bad in bad_results:
            with self.subTest(bad=repr(bad)[:40]), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / "a.txt").write_text("a\n")

                result = select_context("Fix login", ["a.txt"], root=str(root),
                                        backend=BatchBackend([bad]))

                self.assertTrue(result["files"][0]["should_read"])
                self.assertEqual(result["files"][0]["source"], "conservative-fallback")
                self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 1}])

    def test_scalar_and_non_dict_batch_results_fail_open(self):
        bad_batches = [42, "bad", [None]]
        for bad in bad_batches:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / "a.txt").write_text("a\n")

                result = select_context("Fix login", ["a.txt"], root=str(root),
                                        backend=BatchBackend(bad))

                self.assertTrue(result["files"][0]["should_read"])
                self.assertEqual(result["files"][0]["source"], "conservative-fallback")
                self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 1}])

    def test_positive_dropped_tokens_split_even_when_truncated_false(self):
        class DroppedBackend(BatchBackend):
            def state_usage(self, state, questions, head_max_len=None):
                self.usage_calls.append((state, questions, head_max_len))
                if state["candidate_range"] == "1-2":
                    return {"truncated": False, "state_tokens_dropped": 1}
                return {"truncated": False, "state_tokens_dropped": 0}

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\n")
            backend = DroppedBackend([("no", 0.01, 0.99, False)] * 2)

            result = select_context("Fix login", ["a.txt"], root=str(root),
                                    backend=backend, chunk_lines=2)

        self.assertFalse(result["files"][0]["should_read"])
        self.assertEqual(len(backend.batch_calls[0][0]), 2)

    def test_long_task_metadata_overflow_never_classifies_file_chunks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\n")
            backend = BatchBackend(truncate_states=lambda state: state["candidate_excerpt"] == "")

            result = select_context("t" * 5000, ["a.txt"], root=str(root), backend=backend,
                                    chunk_lines=1)

        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["source"], "conservative-fallback")
        self.assertEqual(result["files"][0]["ranges"], [])
        self.assertFalse(result["files"][0]["complete"])
        self.assertFalse(backend.batch_calls)

    def test_line_numbers_split_only_on_lf(self):
        # str.splitlines() would also break on \f, \v, \x85 and U+2028, shifting every later range.
        text = "a\fb\vc\x85d\u2028e\r\nlast\n"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "odd.txt").write_bytes(text.encode("utf-8"))
            backend = BatchBackend([("yes", 0.95, 0.05, False)])
            analyzed = select_context("Fix", ["odd.txt"], root=str(root), backend=backend)
            fallback = select_context("Fix", ["odd.txt"], root=str(root), backend=None)

        for result in (analyzed, fallback):
            self.assertEqual(result["files"][0]["total_lines"], 2)
            self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 2}])
        self.assertEqual(backend.batch_calls[0][0][0]["candidate_excerpt"], "a\fb\vc\x85d\u2028e\nlast")

    def test_line_endings_and_trailing_newline_count_like_an_editor(self):
        cases = {"": 0, "\n": 1, "a": 1, "a\n": 1, "a\r\nb\r\n": 2, "a\n\nb": 3, "a\n\n": 2}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index, (text, expected) in enumerate(cases.items()):
                with self.subTest(text=text):
                    (root / ("f%d.txt" % index)).write_bytes(text.encode("utf-8"))
                    result = select_context("Fix", ["f%d.txt" % index], root=str(root), backend=None)
                    self.assertEqual(result["files"][0]["total_lines"], expected)

    def test_accounting_failure_is_not_reported_as_token_truncation(self):
        class FailingBackend(BatchBackend):
            def __init__(self, fail_when):
                super().__init__()
                self.fail_when = fail_when

            def state_usage(self, state, questions, head_max_len=None):
                if self.fail_when(state):
                    raise RuntimeError("PRIVATE_BACKEND_DETAIL")
                return super().state_usage(state, questions, head_max_len)

        for name, fail_when in (("metadata", lambda state: True),
                                ("chunk", lambda state: state["candidate_excerpt"] != "")):
            with self.subTest(name), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / "a.txt").write_text("a\nb\n")
                backend = FailingBackend(fail_when)

                result = select_context("Fix", ["a.txt"], root=str(root), backend=backend)

                item = result["files"][0]
                self.assertTrue(item["should_read"])
                self.assertFalse(item["complete"])
                self.assertEqual(item["source"], "conservative-fallback")
                warnings = " ".join(item["warnings"])
                self.assertIn("token accounting failed", warnings)
                self.assertNotIn("did not fit", warnings)
                self.assertNotIn("PRIVATE_BACKEND_DETAIL", repr(result))
                self.assertFalse(backend.batch_calls)

    def test_real_truncation_still_reports_the_token_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("x\n")
            result = select_context("Fix", ["a.txt"], root=str(root),
                                    backend=BatchBackend(truncate_states=lambda state: state["candidate_excerpt"] != ""))

        warnings = " ".join(result["files"][0]["warnings"])
        self.assertIn("did not fit the Laya token budget", warnings)
        self.assertNotIn("accounting", warnings)

    def test_preparation_stops_at_the_chunk_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "big.txt").write_text("\n".join("line %d" % i for i in range(1000)))
            (root / "next.txt").write_text("\n".join("line %d" % i for i in range(1000)))
            backend = BatchBackend()

            result = select_context("Fix", ["big.txt", "next.txt"], root=str(root), backend=backend,
                                    chunk_lines=1, max_chunks=1)

        # 1 metadata call per file plus at most limit+1 chunk calls for the first file and one for the second.
        self.assertLessEqual(len(backend.usage_calls), 6)
        self.assertFalse(backend.batch_calls)
        for item in result["files"]:
            self.assertTrue(item["should_read"])
            self.assertFalse(item["complete"])
            self.assertEqual(item["ranges"], [{"start_line": 1, "end_line": 1000}])
            self.assertIn("chunk budget reached before complete coverage; the whole file is recommended", item["warnings"])

    def test_work_limits_have_ceilings_matching_the_ts_runtime(self):
        ceilings = {"max_file_bytes": 1_048_576, "chunk_lines": 500, "max_chunks": 64, "batch_size": 20}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\n")
            for name, ceiling in ceilings.items():
                with self.subTest(name):
                    select_context("Fix", ["a.txt"], root=str(root), backend=BatchBackend(), **{name: ceiling})
                    with self.assertRaises(ValueError):
                        select_context("Fix", ["a.txt"], root=str(root), backend=BatchBackend(), **{name: ceiling + 1})
            for bad in (-1, float("nan"), float("inf"), True, 301):
                with self.subTest(time_budget=bad), self.assertRaises(ValueError):
                    select_context("Fix", ["a.txt"], root=str(root), backend=BatchBackend(), time_budget=bad)

    def test_default_time_budget_stays_below_the_hook_timeout(self):
        self.assertLess(context_selection.DEFAULT_TIME_BUDGET, 60)

    def test_deadline_during_inference_returns_partial_result_with_unevaluated_chunks_included(self):
        now = [0.0]

        class SlowBackend(BatchBackend):
            def predict_batch(self, states, questions, head_max_len=None, batch_size=None):
                now[0] += 10 * len(states)
                return super().predict_batch(states, questions, head_max_len, batch_size)

        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(context_selection, "_monotonic", lambda: now[0]):
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\nc\nd\n")
            backend = SlowBackend([("no", 0.01, 0.99, False)] * 4)

            result = select_context("Fix", ["a.txt"], root=str(root), backend=backend,
                                    chunk_lines=1, batch_size=4, time_budget=15)

        # The first batch is small (2 chunks) to measure cost; at 10 s/chunk nothing else fits.
        self.assertEqual([len(call[0]) for call in backend.batch_calls], [2])
        item = result["files"][0]
        self.assertTrue(item["should_read"])
        self.assertFalse(item["complete"])
        self.assertEqual(item["source"], "conservative-fallback")
        self.assertEqual(item["ranges"], [{"start_line": 3, "end_line": 4}])
        self.assertIn("time budget exhausted before this chunk was evaluated; reading is recommended", item["warnings"])
        self.assertIn("time budget exhausted; unevaluated chunks are recommended for reading", result["warnings"])
        self.assertFalse(result["complete"])

    def test_batches_shrink_to_fit_the_remaining_time_and_never_overrun_the_budget(self):
        now = [0.0]
        ends = []

        class SlowBackend(BatchBackend):
            def predict_batch(self, states, questions, head_max_len=None, batch_size=None):
                now[0] += 4 * len(states)  # 4 s per chunk
                ends.append(now[0])
                return super().predict_batch(states, questions, head_max_len, batch_size)

        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(context_selection, "_monotonic", lambda: now[0]):
            root = Path(folder)
            (root / "a.txt").write_text("\n".join("line %d" % i for i in range(20)))
            backend = SlowBackend([("no", 0.01, 0.99, False)] * 20)

            result = select_context("Fix", ["a.txt"], root=str(root), backend=backend,
                                    chunk_lines=1, batch_size=8, time_budget=45)

        # 2 chunks to measure (t=8), then 8 chunks fit in 37 s (t=40), then only 1 fits in the last 5 s (t=44).
        self.assertEqual([len(call[0]) for call in backend.batch_calls], [2, 8, 1])
        self.assertLessEqual(max(ends), 45)
        item = result["files"][0]
        self.assertTrue(item["should_read"])
        self.assertFalse(item["complete"])
        self.assertEqual(item["ranges"], [{"start_line": 12, "end_line": 20}])

    def test_a_cost_spike_in_a_later_batch_stops_further_scheduling(self):
        now = [0.0]

        class SpikyBackend(BatchBackend):
            def predict_batch(self, states, questions, head_max_len=None, batch_size=None):
                now[0] += (1 if not self.batch_calls else 20) * len(states)
                return super().predict_batch(states, questions, head_max_len, batch_size)

        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(context_selection, "_monotonic", lambda: now[0]):
            root = Path(folder)
            (root / "a.txt").write_text("\n".join("line %d" % i for i in range(12)))
            backend = SpikyBackend([("no", 0.01, 0.99, False)] * 12)

            result = select_context("Fix", ["a.txt"], root=str(root), backend=backend,
                                    chunk_lines=1, batch_size=4, time_budget=30)

        # 1 s/chunk after the first batch lets 4 chunks start at t=2; they take 80 s, so nothing else is scheduled.
        self.assertEqual([len(call[0]) for call in backend.batch_calls], [2, 4])
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 7, "end_line": 12}])

    def test_finishing_inside_the_budget_is_complete(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\n")

            result = select_context("Fix", ["a.txt"], root=str(root),
                                    backend=BatchBackend([("no", 0.01, 0.99, False)]), chunk_lines=1, batch_size=1)

        self.assertTrue(result["complete"])
        self.assertEqual(result["warnings"], [])
        self.assertFalse(result["files"][0]["should_read"])

    def test_deadline_during_preparation_recommends_the_whole_file_without_inference(self):
        now = [0.0]

        class SlowAccounting(BatchBackend):
            def state_usage(self, state, questions, head_max_len=None):
                now[0] += 10
                return super().state_usage(state, questions, head_max_len)

        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(context_selection, "_monotonic", lambda: now[0]):
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\nc\nd\ne\n")
            (root / "b.txt").write_text("x\ny\n")
            backend = SlowAccounting()

            result = select_context("Fix", ["a.txt", "b.txt"], root=str(root), backend=backend,
                                    chunk_lines=1, time_budget=15)

        self.assertFalse(backend.batch_calls)
        self.assertEqual(len(backend.usage_calls), 3)  # file a: metadata + 1 chunk before expiry; file b: metadata only
        self.assertEqual([file["ranges"] for file in result["files"]],
                         [[{"start_line": 1, "end_line": 5}], [{"start_line": 1, "end_line": 2}]])
        for item in result["files"]:
            self.assertTrue(item["should_read"])
            self.assertFalse(item["complete"])
            self.assertIn("time budget exhausted before complete coverage; the whole file is recommended", item["warnings"])
        self.assertFalse(result["complete"])

    def test_zero_time_budget_fails_open_for_every_chunk(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\n")
            backend = BatchBackend()

            result = select_context("Fix", ["a.txt"], root=str(root), backend=backend, time_budget=0)

        self.assertFalse(backend.batch_calls)
        self.assertTrue(result["files"][0]["should_read"])
        self.assertEqual(result["files"][0]["ranges"], [{"start_line": 1, "end_line": 2}])
        self.assertFalse(result["complete"])

    def test_every_emitted_warning_is_in_the_stable_allowlist(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.txt").write_text("a\nb\n")
            (root / "bin").write_bytes(b"\x00")
            (root / "nonutf").write_bytes(b"\xff\xfe")
            (root / "long.txt").write_text("x" * 20001)
            results = [
                select_context("Fix", ["missing", "bin", "nonutf", "long.txt", "a.txt"], root=str(root),
                               backend=BatchBackend()),
                select_context("Fix", ["a.txt"], root=str(root), backend=None),
                select_context("Fix", ["a.txt"], root=str(root), backend=BatchBackend({}), time_budget=0),
                select_context("Fix", ["a.txt"], root=str(root), backend=BatchBackend([None])),
                select_context("Fix", ["a.txt"], root=str(root), chunk_lines=1, max_chunks=1,
                               backend=BatchBackend()),
                select_context("Fix", ["a.txt"], root=str(root),
                               backend=BatchBackend(truncate_states=lambda state: state["candidate_excerpt"] != "")),
                select_context("Fix", ["a.txt"], root=str(root),
                               backend=BatchBackend([("no", 0.01, 0.99, True)])),
            ]

        emitted = {warning for result in results
                   for warning in [*result["warnings"], *(w for file in result["files"] for w in file["warnings"])]}
        self.assertTrue(emitted)
        self.assertLessEqual(emitted, set(CONTEXT_SELECTION_WARNINGS))

    def test_limits_inputs(self):
        with self.assertRaises(ValueError):
            select_context("", [], backend=BatchBackend())
        with self.assertRaises(ValueError):
            select_context("Fix", ["x%d" % i for i in range(21)], backend=BatchBackend())
        with self.assertRaises(TypeError):
            select_context("Fix", "x", backend=BatchBackend())


if __name__ == "__main__":
    unittest.main()
