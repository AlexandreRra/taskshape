"""Lab (dataset, compare, adopt) and records tests; no ML dependencies."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from taskshape import catalog, lab, records  # noqa: E402

PROFILES = ROOT / "catalog/profiles.example.json"
CATALOG = ROOT / "catalog/models.json"


def report(checkpoint, splits, sha="abc", dataset_sha="same"):
    return {"checkpoint": checkpoint, "checkpoint_sha256": sha,
            "splits": {name: {"dataset_sha256": dataset_sha if isinstance(dataset_sha, str) else dataset_sha[name],
                              "metrics": {"n": 10, "accuracy": acc, "ece": ece, "mean_answer_confidence": conf}}
                       for name, (acc, ece, conf) in splits.items()}}


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        briefs = []
        for template in range(10):
            for variant in range(3):
                briefs.append({"task": "Template %d variant %d: own module%d.py; the migration must be idempotent" % (template, variant, variant),
                               "phase": "work", "template": "t%d" % template})
        briefs.append({"task": "Fix the typo in README", "phase": "work", "shape": "routine"})
        briefs.append({"task": "Read-only review of the diff", "phase": "review", "role": "code-reviewer"})
        briefs.append({"task": "Fix the typo in README", "phase": "work"})  # duplicate text
        briefs.append({"task": "", "phase": "work"})
        briefs.append({"task": "Review this", "phase": "work", "shape": "review"})  # review shape not allowed in work
        self.briefs = self.root / "briefs.jsonl"
        lab.write_jsonl(self.briefs, briefs)

    def test_dataset_labels_splits_by_template_and_reports_leaks(self):
        meta = lab.build_dataset(self.briefs, self.root / "lab", seed=1)
        self.assertEqual(meta["skipped"], 3)
        rows = lab.read_jsonl(self.root / "lab/all.jsonl")
        self.assertEqual(len(rows), 32)
        by_id = {row["id"]: row for row in rows}
        self.assertEqual(by_id["b-00030"]["expected"], {"shape": "routine"})
        self.assertEqual(by_id["b-00030"]["labelled_by"], "human")
        self.assertEqual(by_id["b-00031"]["expected"], {"shape": "review"})
        self.assertEqual(by_id["b-00000"]["expected"], {"shape": "coupled"})
        for row in rows:
            self.assertEqual(set(row["questions"]["shape"]["criteria"]), set(row["gold"]["shape"]["probabilities"]))
            self.assertEqual(max(row["gold"]["shape"]["probabilities"], key=row["gold"]["shape"]["probabilities"].get), row["expected"]["shape"])
        train = lab.read_jsonl(self.root / "lab/train.jsonl")
        heldout = lab.read_jsonl(self.root / "lab/heldout.jsonl")
        self.assertFalse({r["template"] for r in train if r["template"]} & {r["template"] for r in heldout if r["template"]})
        self.assertEqual(meta["heldout_text_leaks"], [])
        self.assertEqual(len(train) + len(heldout), len(rows))
        again = lab.build_dataset(self.briefs, self.root / "lab2", seed=1)
        self.assertEqual(again["files"]["train"]["sha256"], meta["files"]["train"]["sha256"])


class CompareAdoptTests(unittest.TestCase):
    def test_compare_gates(self):
        base = report("base", {"heldout": (0.4, 0.3, 0.35)})
        self.assertTrue(lab.compare(base, report("new", {"heldout": (0.8, 0.1, 0.75)}))["wins"])
        self.assertFalse(lab.compare(base, report("new", {"heldout": (0.3, 0.1, 0.3)}))["wins"])
        self.assertFalse(lab.compare(base, report("new", {"heldout": (0.6, 0.5, 0.95)}))["wins"])   # over-confident
        self.assertTrue(lab.compare(base, report("new", {"heldout": (0.7, 0.4, 0.45)}))["wins"])    # under-confident, allowed
        self.assertFalse(lab.compare(base, report("new", {"heldout": (0.8, 0.1, 0.75)}, dataset_sha="other"))["wins"])
        self.assertIn("WINS", lab.markdown_comparison(lab.compare(base, report("new", {"heldout": (0.8, 0.1, 0.75)}))))
        with self.assertRaises(ValueError):
            lab.compare(base, report("x", {"train": (1, 0, 1)}))

    def test_adopt_requires_full_provenance(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        ckpt = root / "checkpoints/new"
        ckpt.mkdir(parents=True)
        (ckpt / "model.safetensors").write_bytes(b"weights")
        digest = lab.sha256_file(ckpt / "model.safetensors")
        (ckpt / "rl_agent_config.json").write_text(json.dumps({"taskshape": {"train_sha256": "train-sha"}}))
        meta = {"files": {"train": {"sha256": "train-sha"}, "heldout": {"sha256": "held-sha"}}}
        base = report("base", {"heldout": (0.4, 0.3, 0.35)}, dataset_sha="held-sha")
        winner = report(str(ckpt), {"heldout": (0.8, 0.1, 0.75)}, sha=digest, dataset_sha="held-sha")
        config = root / "taskshape.json"
        refusals = {
            "loser": (ckpt, base, report(str(ckpt), {"heldout": (0.3, 0.1, 0.3)}, sha=digest, dataset_sha="held-sha"), meta),
            "forged sha": (ckpt, base, report(str(ckpt), {"heldout": (0.8, 0.1, 0.75)}, sha="x", dataset_sha="held-sha"), meta),
            "wrong train build": (ckpt, base, winner, {"files": {"train": {"sha256": "other"}, "heldout": {"sha256": "held-sha"}}}),
            "wrong heldout build": (ckpt, base, winner, {"files": {"train": {"sha256": "train-sha"}, "heldout": {"sha256": "other"}}}),
            "missing split": (ckpt, base, report(str(ckpt), {"train": (0.9, 0.1, 0.9)}, sha=digest), meta),
            "missing checkpoint": (root / "nope", base, winner, meta),
        }
        for name, args in refusals.items():
            with self.subTest(refusal=name), self.assertRaises(ValueError):
                lab.adopt(config, *args)
        self.assertFalse(config.exists())
        result = lab.adopt(config, ckpt, base, winner, meta)
        current = lab.load_config(config)
        self.assertEqual(current["revision"], "sha256:" + digest)
        self.assertEqual(current["checkpoint"], str(ckpt))
        self.assertIsNone(result["previous"]["checkpoint"])
        # Second adoption must be measured against the now-live checkpoint.
        with self.assertRaises(ValueError):
            lab.adopt(config, ckpt, report("stale", {"heldout": (0.4, 0.3, 0.35)}, dataset_sha="held-sha"),
                      report(str(ckpt), {"heldout": (0.9, 0.1, 0.8)}, sha=digest, dataset_sha="held-sha"), meta)


class RecordTests(unittest.TestCase):
    def test_record_and_report_suggest_cheapest_holding_profile(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "records/outcomes.jsonl"
        models = catalog.load_models(CATALOG)
        profiles = catalog.load_profiles(PROFILES, models)["profiles"]
        for _ in range(12):
            records.record(path, "demanding", "sonnet-high", "claude-sonnet-5-5", "high", True, task="t", input_tokens=50_000,
                           output_tokens=5_000, seconds=30, models=models)
        for i in range(12):
            records.record(path, "demanding", "sol-medium", "gpt-6-sol", "medium", i % 2 == 0, task="t")
        for _ in range(3):
            records.record(path, "demanding", "luna-low", "gpt-6-luna", "low", True, task="t")
        with self.assertRaises(ValueError):
            records.record(path, "teleport", "x", "y", "z", True)
        rows = records.load(path)
        self.assertEqual(len(rows), 27)
        result = records.report(rows, profiles)
        cell = result["cells"]["demanding/sonnet-high"]
        self.assertEqual((cell["n"], cell["acceptance"]), (12, 1.0))
        self.assertGreater(cell["mean_cost_usd"], 0)
        self.assertEqual(result["cells"]["demanding/sol-medium"]["acceptance"], 0.5)
        self.assertEqual(result["suggestions"]["demanding"]["cheapest_profile_holding_up"], "sonnet-high")  # luna: too few samples
        self.assertNotIn("coupled", result["suggestions"])

    def test_decision_audit_log(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / "records/decisions.jsonl"
        row = records.append_decision(path, {"task": "x", "phase": "work", "shape": "routine", "profile": "sol-medium", "model": "gpt-6-sol",
                                             "effort": "medium", "answer_confidence": 0.7, "source": "heuristic", "warnings": []}, origin="test")
        self.assertEqual((row["origin"], row["shape"], row["profile"]), ("test", "routine", "sol-medium"))
        self.assertEqual(len(path.read_text().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
