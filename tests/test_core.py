"""Core tests: shapes, catalog validation, policy, rubric, router (no ML dependencies)."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape import catalog, policy, rubric, router, shapes  # noqa: E402

CATALOG = ROOT / "catalog/models.json"
PROFILES = ROOT / "catalog/profiles.example.json"


class ShapeTests(unittest.TestCase):
    def test_phases_and_capabilities(self):
        self.assertEqual(shapes.shapes_for("review"), ["review", "architecture"])
        self.assertNotIn("review", shapes.shapes_for("work"))
        self.assertEqual(shapes.required_capability("architecture"), 4)
        with self.assertRaises(ValueError):
            shapes.shapes_for("deploy")
        for name, shape in shapes.SHAPES.items():
            self.assertLessEqual(len(shape["criteria"]), 240, name)


class CatalogTests(unittest.TestCase):
    def test_shipped_catalog_and_example_profiles_validate_and_cross_check(self):
        models = catalog.load_models(CATALOG)
        value = catalog.load_profiles(PROFILES, models)
        self.assertGreaterEqual(len(models["models"]), 8)
        self.assertTrue(all(m.get("sources") for m in models["models"]))
        self.assertEqual({p["id"] for p in value["profiles"]} & {"sol-medium", "opus-high"}, {"sol-medium", "opus-high"})
        self.assertIsNotNone(catalog.estimate_cost_usd(models, "claude-sonnet-5-5", 100_000, 10_000))
        self.assertIsNone(catalog.estimate_cost_usd(models, "gpt-6.1-sol", 1, 1))  # unverified price stays None

    def test_invalid_profiles_are_refused(self):
        models = catalog.load_models(CATALOG)
        good = json.loads(PROFILES.read_text())
        variants = {
            "unknown model": lambda v: v["profiles"][0].update(model="gpt-9"),
            "capability out of range": lambda v: v["profiles"][0].update(capability=7),
            "bool cost": lambda v: v["profiles"][0].update(cost_tier=True),
            "duplicate id": lambda v: v["profiles"].append(dict(v["profiles"][0])),
            "bad phase": lambda v: v["profiles"][0].update(phases=["deploy"]),
            "bad budget": lambda v: v["budgets"].update(x={"max_cost_tier": 9}),
            "empty": lambda v: v.update(profiles=[]),
        }
        for name, mutate in variants.items():
            value = json.loads(json.dumps(good))
            mutate(value)
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
                json.dump(value, handle)
            with self.subTest(name=name), self.assertRaises(ValueError):
                catalog.load_profiles(handle.name, models)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write("[]")
        with self.assertRaises(ValueError):
            catalog.load_models(handle.name)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.profiles = catalog.load_profiles(PROFILES)["profiles"]

    def test_cheapest_adequate_profile_wins_and_budget_caps_escalate_with_warning(self):
        # Same cost tier: the more capable profile wins the tie (flash-high is tier 1, capability 2).
        self.assertEqual(policy.choose("routine", self.profiles).profile["id"], "flash-high")
        self.assertEqual(policy.choose("routine", self.profiles, allowed={"sol-medium", "sonnet-medium", "sol-high"}).profile["id"], "sol-medium")
        self.assertEqual(policy.choose("demanding", self.profiles).profile["id"], "flash-high")  # cheapest tier covering 2
        self.assertEqual(policy.choose("coupled", self.profiles).profile["id"], "sol61-high")
        self.assertEqual(policy.choose("architecture", self.profiles).profile["id"], "opus-high")  # tier 4 beats astra tier 5
        self.assertEqual(policy.choose("review", self.profiles, phase="review").profile["id"], "sol61-high")
        self.assertEqual(policy.choose("visual", self.profiles).profile["id"], "flash-high")
        self.assertEqual(policy.choose("lookup", self.profiles).profile["id"], "luna-low")
        capped = policy.choose("architecture", self.profiles, max_cost_tier=2)
        self.assertEqual(capped.profile["capability"], 2)
        self.assertTrue(capped.warnings and "under-provisioned" in capped.warnings[0])
        with self.assertRaises(ValueError):
            policy.choose("coupled", self.profiles, phase="review", max_cost_tier=0)
        with self.assertRaises(ValueError):
            policy.choose("teleport", self.profiles)
        allowed = policy.choose("routine", self.profiles, allowed={"opus-high", "astra-high"})
        self.assertEqual(allowed.profile["id"], "opus-high")

    def test_table_is_visible_for_every_budget(self):
        budgets = catalog.load_profiles(PROFILES)["budgets"]
        work = policy.table(self.profiles, budgets, "work")
        self.assertEqual(work["architecture"]["premium"]["profile"], "opus-high")
        self.assertEqual(work["architecture"]["economy"]["profile"], "flash-high")
        self.assertTrue(work["architecture"]["economy"]["warnings"])
        self.assertEqual(set(policy.table(self.profiles, budgets, "review")), {"review", "architecture"})


class RubricTests(unittest.TestCase):
    def test_shapes_from_cues_and_roles(self):
        cases = [
            ("work", None, "Fix the typo in README and bump the version", "routine"),
            ("work", None, "Own ledger.py and tests; keep the v3 ledger format readable; the migration must be idempotent", "coupled"),
            ("work", None, "Implement the export feature; cause of the flaky upload not yet confirmed; reproduce first, several steps", "demanding"),
            ("work", None, "Write the ADR for the queue redesign; weigh tradeoffs; no code", "architecture"),
            ("work", None, "Review the screenshot of the settings page against the mockup and list visual defects", "visual"),
            ("work", None, "Find the exact string 'retry-after' in the client package", "lookup"),
            ("work", "debugger", "Why does the nightly job fail?", "coupled"),
            ("work", "explore", "Where does the HUD get its scale? list files", "routine"),
            ("review", "code-reviewer", "Read-only review of the label diff; no edits", "review"),
            ("review", None, "Challenge the proposed architecture for the cache layer; tradeoffs", "architecture"),
            ("work", None, "Third attempt after two failed repairs; escalate and reassess the design", "architecture"),
        ]
        for phase, role, text, expected in cases:
            with self.subTest(text=text[:40]):
                self.assertEqual(rubric.classify(text, phase, role), expected)

    def test_citations_and_negations_do_not_escalate(self):
        self.assertEqual(rubric.classify("Fix the label contrast; applies RFC-7 and the save-format spec; docs-only"), "routine")
        self.assertEqual(rubric.classify("Rename the config keys; no schema changes; persistence untouched"), "routine")
        self.assertEqual(rubric.classify("Wording fix; do not escalate; according to the migration guide section 3"), "routine")

    def test_soft_targets(self):
        target = rubric.soft_target("coupled", shapes.shapes_for("work"))
        self.assertEqual(max(target, key=target.get), "coupled")
        self.assertAlmostEqual(sum(target.values()), 1.0, places=3)
        self.assertGreater(target["demanding"], target["lookup"])
        self.assertLess(target["review"] if "review" in target else 0, target["coupled"])
        with self.assertRaises(ValueError):
            rubric.soft_target("review", shapes.shapes_for("work"))


class SharedTypeScriptTests(unittest.TestCase):
    def test_plugin_copies_of_the_shared_rubric_are_in_sync(self):
        import subprocess
        result = subprocess.run([sys.executable, str(ROOT / "scripts/sync-shared.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.profiles = catalog.load_profiles(PROFILES)["profiles"]

    def test_heuristic_route_end_to_end(self):
        decision = router.route("Own ledger.py and tests; the migration must be idempotent", self.profiles, max_cost_tier=4)
        self.assertEqual((decision.shape, decision.profile, decision.model, decision.effort), ("coupled", "sol61-high", "gpt-6.1-sol", "high"))
        self.assertEqual(decision.source, "heuristic")
        self.assertAlmostEqual(sum(decision.shape_probabilities.values()), 1.0, places=2)
        self.assertIn("cheapest", decision.reason)
        economy = router.route("Write the ADR for the queue redesign; tradeoffs", self.profiles, max_cost_tier=1)
        self.assertEqual(economy.shape, "architecture")
        self.assertTrue(any("under-provisioned" in w for w in economy.warnings))
        review = router.route("Read-only review of the diff", self.profiles, phase="review")
        self.assertEqual((review.shape, review.profile), ("review", "sol61-high"))

    def test_invalid_backend_answers_fall_back_to_the_rubric_with_a_warning(self):
        class Liar:
            name = "liar"

            def predict(self, state, questions, head_max_len=None):
                options = list(questions["shape"]["criteria"])
                return {"answers": {"shape": {"choice": "teleport", "probabilities": {o: 1 / len(options) for o in options},
                                              "answer_confidence": 0.9, "confidence": 0.1}}}

        class Crash:
            def predict(self, *args, **kwargs):
                raise RuntimeError("no weights")

        for backend in (Liar(), Crash()):
            decision = router.route("Fix the typo in README", self.profiles, backend=backend)
            self.assertEqual(decision.source, "heuristic-fallback")
            self.assertEqual(decision.shape, "routine")
            self.assertTrue(any("rubric used" in w for w in decision.warnings))
        for bad in ({"choice": "routine", "probabilities": {"routine": float("nan")}, "answer_confidence": 1, "confidence": 1},
                    {"choice": "routine", "probabilities": {"routine": 0.5, "lookup": 0.5}, "answer_confidence": 0.5, "confidence": 1}):
            with self.assertRaises(ValueError):
                router.validate_answer(bad, ["routine", "lookup", "coupled"])

    def test_questions_match_shapes_and_state_is_bounded(self):
        questions = router.questions_for("work")
        self.assertEqual(set(questions["shape"]["criteria"]), set(shapes.shapes_for("work")))
        state = router.state_for("x" * 10000, "work", {"repo": "y" * 1000})
        self.assertEqual(len(state["task"]), 4000)
        self.assertEqual(len(state["context"]["repo"]), 200)


class CliTests(unittest.TestCase):
    def test_route_allowed_restricts_the_choice_and_rejects_unknown_ids(self):
        import contextlib
        import io
        from taskshape import cli

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task", "Fix the typo in README",
                             "--allowed", "opus-high,astra-high"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["profile"], "opus-high")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = cli.main(["route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task", "x", "--allowed", "nope"])
        self.assertEqual(code, 1)
        self.assertIn("unknown profiles", err.getvalue())

    def test_route_accepts_task_stdin(self):
        import contextlib
        import io
        from taskshape import cli

        old_stdin = sys.stdin
        sys.stdin = io.StringIO("Fix the typo in README")
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = cli.main(["route", "--profiles", str(PROFILES), "--backend", "heuristic", "--task-stdin"])
        finally:
            sys.stdin = old_stdin
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["shape"], "routine")


if __name__ == "__main__":
    unittest.main()
