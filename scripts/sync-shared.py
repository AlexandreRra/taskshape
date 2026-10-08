#!/usr/bin/env python3
"""Copy plugins/shared into each plugin folder (plugins install as self-contained folders).

- shapes/rubric/policy go to every plugin (the Claude Code plugin uses them from its function hook);
- the hook scripts (harness, pretooluse, subagentstop, sessionstart, tests) and profiles.copilot.json go to
  the Copilot CLI and VS Code plugins, which share the same scripts and differ only in manifest and hooks.json.

`--check` also fails on files that sit in a managed destination but come from no source (orphans), on drift between
plugins/claude-code/profiles.builtin.json and DEFAULT_PROFILES/DEFAULT_BUDGETS in plugins/shared/policy.ts, and on
version disagreement between pyproject.toml, src/taskshape/__init__.py, the plugin manifests and the marketplaces.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "plugins/shared"
CORE = ("shapes.ts", "rubric.ts", "policy.ts")
HOOK_PLUGINS = ("plugins/copilot", "plugins/vscode")
ALL_PLUGINS = (*HOOK_PLUGINS, "plugins/claude-code")
PYTHON_CORE = ("__init__.py", "catalog.py", "policy.py", "router.py", "rubric.py", "shapes.py", "relevance.py", "context_selection.py")
CATALOG_DATA = ("models.json", "profiles.example.json")
# Files that live in a managed destination but are the plugin's own, not copies of a shared source.
OWN_FILES = (
    "plugins/claude-code/hooks/register.ts",
    "plugins/claude-code/hooks/register.test.ts",
    "plugins/claude-code/hooks/rubric.test.ts",
)
SCRIPT_SUFFIXES = (".ts", ".sh", ".ps1")
VERSION_FILES = (
    "plugins/claude-code/.claude-plugin/plugin.json",
    "plugins/copilot/plugin.json",
    "plugins/vscode/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".github/plugin/marketplace.json",
)
PROFILE_KEYS = ("id", "model", "capability", "cost_tier", "phases", "vision")


def plan(root: Path = ROOT) -> list[tuple[Path, Path]]:
    shared = root / "plugins/shared"
    pairs = []
    for name in PYTHON_CORE:
        pairs.append((root / "src/taskshape" / name, root / "runtime/taskshape" / name))
    for name in CATALOG_DATA:
        pairs.append((root / "catalog" / name, root / "src/taskshape/data" / name))
    for name in CORE:
        pairs.append((shared / name, root / "plugins/claude-code/hooks" / name))
    for name in ("runtime.ts", "runtime-cli.ts", "launch.sh", "launch.ps1"):
        pairs.append((shared / name, root / "plugins/claude-code/hooks" / name))
    for plugin in HOOK_PLUGINS:
        for source in sorted(shared.iterdir()):
            if source.suffix not in (".ts", ".sh", ".ps1"):
                continue
            pairs.append((source, root / plugin / "hooks" / source.name))
        pairs.append((shared / "profiles.copilot.json", root / plugin / "profiles.copilot.json"))
        for source in sorted((shared / "skills").rglob("*")):
            if source.is_file():
                if source.relative_to(shared / "skills") == Path("select-context/SKILL.md"):
                    continue
                pairs.append((source, root / plugin / "skills" / source.relative_to(shared / "skills")))
    for plugin in ALL_PLUGINS:
        source = shared / "skills/select-context/SKILL.md"
        pairs.append((source, root / plugin / "skills/select-context/SKILL.md"))
    for plugin in ALL_PLUGINS:
        for source in sorted((root / "runtime").glob("*")):
            if source.is_file():
                pairs.append((source, root / plugin / "runtime" / source.name))
        for name in PYTHON_CORE:
            pairs.append((root / "src/taskshape" / name, root / plugin / "runtime/taskshape" / name))
    return pairs


def _files(directory: Path, suffixes: tuple[str, ...] | None = None, recursive: bool = True) -> list[Path]:
    if not directory.is_dir():
        return []
    found = directory.rglob("*") if recursive else directory.glob("*")
    return [path for path in found if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
            and (suffixes is None or path.suffix in suffixes)]


def orphans(root: Path = ROOT) -> list[str]:
    """Files in a managed destination that no source produces.

    Managed scope: runtime/taskshape, src/taskshape/data, every plugin's runtime/ and the script files
    (.ts/.sh/.ps1) of its hooks/ except OWN_FILES, all of skills/ in the Copilot and VS Code plugins, and in
    Claude Code the skills that share a name with a shared skill. Manifests, hooks.json, READMEs, profiles and the
    Claude `.claude-plugin/types` tree are the plugin's own and are never inspected.
    """
    shared = root / "plugins/shared"
    produced = {dest for _, dest in plan(root)} | {root / name for name in OWN_FILES}
    candidates = [*_files(root / "runtime/taskshape"), *_files(root / "src/taskshape/data")]
    for plugin in ALL_PLUGINS:
        base = root / plugin
        candidates += _files(base / "runtime")
        candidates += _files(base / "hooks", SCRIPT_SUFFIXES, recursive=False)
        if plugin in HOOK_PLUGINS:
            candidates += _files(base / "skills")
        else:
            for skill in sorted(path for path in (shared / "skills").glob("*") if path.is_dir()):
                candidates += _files(base / "skills" / skill.name)
    return sorted({str(path.relative_to(root)) for path in candidates if path not in produced})


def _typescript_value(raw: str):
    raw = raw.strip()
    if raw.startswith("["):
        return re.findall(r"'([^']*)'", raw)
    if raw.startswith("'"):
        return raw[1:-1]
    if raw in ("true", "false"):
        return raw == "true"
    return int(raw)


def profile_errors(root: Path = ROOT) -> list[str]:
    """Compare profiles.builtin.json with DEFAULT_PROFILES and DEFAULT_BUDGETS (read-only parse of policy.ts).

    The JSON also carries `provider` and `effort`, which the TypeScript table does not model; they are not compared.
    """
    builtin_path = root / "plugins/claude-code/profiles.builtin.json"
    policy_path = root / "plugins/shared/policy.ts"
    try:
        builtin = json.loads(builtin_path.read_text(encoding="utf-8"))
        policy = policy_path.read_text(encoding="utf-8")
    except (OSError, ValueError) as error:
        return ["cannot read %s or %s: %s" % (builtin_path.name, policy_path.name, error)]
    table = re.search(r"DEFAULT_PROFILES: Profile\[\] = \[(.*?)\n\]", policy, re.S)
    budgets = re.search(r"DEFAULT_BUDGETS: Budgets = (\{.*\})", policy)
    if not table or not budgets:
        return ["cannot find DEFAULT_PROFILES or DEFAULT_BUDGETS in policy.ts"]
    try:
        expected = [{key: _typescript_value(value) for key, value in re.findall(r"(\w+):\s*(\[[^\]]*\]|'[^']*'|\w+)", entry)}
                    for entry in re.findall(r"\{[^{}]*\}", table.group(1))]
    except ValueError as error:
        return ["cannot parse DEFAULT_PROFILES: %s" % error]
    expected_budgets = {name: {"max_cost_tier": int(tier)}
                        for name, tier in re.findall(r"(\w+):\s*\{\s*max_cost_tier:\s*(\d+)\s*\}", budgets.group(1))}
    actual = [{key: profile.get(key) for key in PROFILE_KEYS} for profile in builtin.get("profiles", [])]
    expected = [{key: profile.get(key, False if key == "vision" else None) for key in PROFILE_KEYS} for profile in expected]
    errors = []
    if actual != expected:
        errors.append("profiles differ: profiles.builtin.json %s vs DEFAULT_PROFILES %s" % (json.dumps(actual), json.dumps(expected)))
    if builtin.get("budgets") != expected_budgets:
        errors.append("budgets differ: profiles.builtin.json %s vs DEFAULT_BUDGETS %s"
                      % (json.dumps(builtin.get("budgets")), json.dumps(expected_budgets)))
    return errors


def version_errors(root: Path = ROOT) -> list[str]:
    found: dict[str, str] = {}
    try:
        pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")
        init = (root / "src/taskshape/__init__.py").read_text(encoding="utf-8")
        match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.M)
        found["pyproject.toml"] = match.group(1) if match else "<missing>"
        match = re.search(r'^__version__\s*=\s*"([^"]+)"', init, re.M)
        found["src/taskshape/__init__.py"] = match.group(1) if match else "<missing>"
        for name in VERSION_FILES:
            data = json.loads((root / name).read_text(encoding="utf-8"))
            if "plugins" in data:
                for entry in data["plugins"]:
                    found["%s (%s)" % (name, entry.get("name"))] = str(entry.get("version", "<missing>"))
            else:
                found[name] = str(data.get("version", "<missing>"))
    except (OSError, ValueError) as error:
        return ["cannot read version sources: %s" % error]
    if len(set(found.values())) > 1:
        return ["%s = %s" % (name, version) for name, version in found.items()]
    return []


def main() -> int:
    check = "--check" in sys.argv
    stale = []
    for source, dest in plan():
        if check:
            if not dest.exists() or dest.read_bytes() != source.read_bytes():
                stale.append(str(dest.relative_to(ROOT)))
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
    problems = []
    if stale:
        problems.append("out of sync:\n  " + "\n  ".join(stale))
    if check:
        for title, items in (("orphans (no source produces them):", orphans()),
                             ("profiles.builtin.json drifted from policy.ts:", profile_errors()),
                             ("inconsistent versions:", version_errors())):
            if items:
                problems.append(title + "\n  " + "\n  ".join(items))
    if problems:
        print("\n".join(problems))
        return 1
    print("ok" if check else "synced %d files" % len(plan()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
