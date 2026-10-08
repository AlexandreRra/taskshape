import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts/sync-shared.py"
spec = importlib.util.spec_from_file_location("sync_shared", SCRIPT)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

POLICY_TS = """export const DEFAULT_PROFILES: Profile[] = [
  { id: 'haiku', model: 'claude-haiku-4-5', capability: 1, cost_tier: 0, phases: ['work'], vision: true },
  { id: 'opus', model: 'claude-opus-5-5', capability: 4, cost_tier: 3, phases: ['work', 'review'], vision: false },
]
export const DEFAULT_BUDGETS: Budgets = { economy: { max_cost_tier: 1 }, default: { max_cost_tier: 5 } }
"""
BUILTIN = {
    "version": 1,
    "profiles": [
        {"id": "haiku", "model": "claude-haiku-4-5", "provider": "anthropic", "effort": "default", "capability": 1,
         "cost_tier": 0, "phases": ["work"], "vision": True},
        {"id": "opus", "model": "claude-opus-5-5", "provider": "anthropic", "effort": "default", "capability": 4,
         "cost_tier": 3, "phases": ["work", "review"], "vision": False},
    ],
    "budgets": {"economy": {"max_cost_tier": 1}, "default": {"max_cost_tier": 5}},
}


def write(root: Path, name: str, text: str = "x") -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def build_repo(root: Path) -> None:
    for name in sync.PYTHON_CORE:
        write(root, "src/taskshape/" + name, "# " + name)
    for name in sync.CATALOG_DATA:
        write(root, "catalog/" + name, "{}")
    for name in (*sync.CORE, "runtime.ts", "runtime-cli.ts", "launch.sh", "launch.ps1", "harness.ts", "harness.test.ts"):
        write(root, "plugins/shared/" + name, "// " + name)
    write(root, "plugins/shared/profiles.copilot.json", "{}")
    write(root, "plugins/shared/skills/select-context/SKILL.md")
    write(root, "plugins/shared/skills/file-relevance/SKILL.md")
    for name in ("classify.py", "assets.json", "requirements.lock"):
        write(root, "runtime/" + name)
    write(root, "plugins/shared/policy.ts", POLICY_TS)
    write(root, "plugins/claude-code/profiles.builtin.json", json.dumps(BUILTIN))
    for name in sync.OWN_FILES:
        write(root, name, "// own")
    write(root, "pyproject.toml", '[project]\nname = "taskshape"\nversion = "1.0.0"\n')
    write(root, "src/taskshape/__init__.py", '__version__ = "1.0.0"\n')
    for name in ("plugins/claude-code/.claude-plugin/plugin.json", "plugins/copilot/plugin.json",
                 "plugins/vscode/.claude-plugin/plugin.json"):
        write(root, name, json.dumps({"name": "taskshape", "version": "1.0.0"}))
    for name in (".claude-plugin/marketplace.json", ".github/plugin/marketplace.json"):
        write(root, name, json.dumps({"plugins": [{"name": "a", "version": "1.0.0"}, {"name": "b", "version": "1.0.0"}]}))
    for source, dest in sync.plan(root):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(source.read_bytes())
    # Files each plugin legitimately owns must never be reported.
    for name in ("plugins/claude-code/hooks/hooks.json", "plugins/copilot/hooks.json", "plugins/vscode/hooks/hooks.json",
                 "plugins/copilot/README.md", "plugins/claude-code/.claude-plugin/types/claude-code/index.d.ts",
                 "plugins/claude-code/skills/own-skill/SKILL.md"):
        write(root, name)
    write(root, "plugins/claude-code/runtime/taskshape/__pycache__/x.cpython-312.pyc")


class SyncSharedCheckTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        build_repo(self.root)

    def test_clean_tree_has_no_findings(self):
        self.assertEqual(sync.orphans(self.root), [])
        self.assertEqual(sync.profile_errors(self.root), [])
        self.assertEqual(sync.version_errors(self.root), [])

    def test_orphans_in_every_managed_destination_are_reported(self):
        extras = [
            "runtime/taskshape/removed.py",
            "src/taskshape/data/old.json",
            "plugins/claude-code/runtime/taskshape/removed.py",
            "plugins/vscode/runtime/stale.lock",
            "plugins/claude-code/hooks/removed.ts",
            "plugins/copilot/hooks/removed.sh",
            "plugins/vscode/hooks/removed.ps1",
            "plugins/copilot/skills/gone/SKILL.md",
            "plugins/claude-code/skills/file-relevance/SKILL.md",
        ]
        for name in extras:
            write(self.root, name)
        self.assertEqual(sync.orphans(self.root), sorted(extras))

    def test_a_source_removed_after_syncing_turns_its_copy_into_an_orphan(self):
        (self.root / "plugins/shared/harness.test.ts").unlink()
        self.assertEqual(sync.orphans(self.root), ["plugins/copilot/hooks/harness.test.ts", "plugins/vscode/hooks/harness.test.ts"])

    def test_profile_drift_is_reported(self):
        builtin = json.loads(json.dumps(BUILTIN))
        builtin["profiles"][1]["capability"] = 3
        write(self.root, "plugins/claude-code/profiles.builtin.json", json.dumps(builtin))
        self.assertTrue(any(error.startswith("profiles differ") for error in sync.profile_errors(self.root)))

    def test_budget_drift_and_missing_profile_are_reported(self):
        builtin = json.loads(json.dumps(BUILTIN))
        builtin["budgets"]["default"]["max_cost_tier"] = 4
        del builtin["profiles"][0]
        write(self.root, "plugins/claude-code/profiles.builtin.json", json.dumps(builtin))
        errors = sync.profile_errors(self.root)
        self.assertEqual(sorted(error.split(":")[0] for error in errors), ["budgets differ", "profiles differ"])

    def test_unparseable_policy_is_an_error_not_a_pass(self):
        write(self.root, "plugins/shared/policy.ts", "export const OTHER = 1\n")
        self.assertEqual(sync.profile_errors(self.root), ["cannot find DEFAULT_PROFILES or DEFAULT_BUDGETS in policy.ts"])

    def test_version_disagreement_lists_every_source(self):
        write(self.root, "plugins/copilot/plugin.json", json.dumps({"name": "taskshape", "version": "1.0.1"}))
        write(self.root, ".github/plugin/marketplace.json", json.dumps({"plugins": [{"name": "a", "version": "0.9.0"}]}))
        errors = sync.version_errors(self.root)
        self.assertIn("plugins/copilot/plugin.json = 1.0.1", errors)
        self.assertIn(".github/plugin/marketplace.json (a) = 0.9.0", errors)
        self.assertIn("pyproject.toml = 1.0.0", errors)

    def test_missing_version_source_is_an_error(self):
        (self.root / "plugins/vscode/.claude-plugin/plugin.json").unlink()
        self.assertEqual(len(sync.version_errors(self.root)), 1)


class RepositoryTests(unittest.TestCase):
    def test_repository_has_no_orphans_profile_drift_or_version_mismatch(self):
        self.assertEqual(sync.orphans(), [])
        self.assertEqual(sync.profile_errors(), [])
        self.assertEqual(sync.version_errors(), [])


if __name__ == "__main__":
    unittest.main()
