#!/usr/bin/env python3
"""Copy plugins/shared into each plugin folder (plugins install as self-contained folders).

- shapes/rubric/policy go to every plugin (the Claude Code plugin uses them from its function hook);
- the hook scripts (harness, pretooluse, subagentstop, sessionstart, tests) and profiles.copilot.json go to
  the Copilot CLI and VS Code plugins, which share the same scripts and differ only in manifest and hooks.json.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "plugins/shared"
CORE = ("shapes.ts", "rubric.ts", "policy.ts")
HOOK_PLUGINS = ("plugins/copilot", "plugins/vscode")
ALL_PLUGINS = (*HOOK_PLUGINS, "plugins/claude-code")
PYTHON_CORE = ("__init__.py", "catalog.py", "policy.py", "router.py", "rubric.py", "shapes.py")
CATALOG_DATA = ("models.json", "profiles.example.json")


def plan() -> list[tuple[Path, Path]]:
    pairs = []
    for name in PYTHON_CORE:
        pairs.append((ROOT / "src/taskshape" / name, ROOT / "runtime/taskshape" / name))
    for name in CATALOG_DATA:
        pairs.append((ROOT / "catalog" / name, ROOT / "src/taskshape/data" / name))
    for name in CORE:
        pairs.append((SHARED / name, ROOT / "plugins/claude-code/hooks" / name))
    for name in ("runtime.ts", "runtime-cli.ts", "launch.sh", "launch.ps1"):
        pairs.append((SHARED / name, ROOT / "plugins/claude-code/hooks" / name))
    for plugin in HOOK_PLUGINS:
        for source in sorted(SHARED.iterdir()):
            if source.suffix not in (".ts", ".sh", ".ps1"):
                continue
            pairs.append((source, ROOT / plugin / "hooks" / source.name))
        pairs.append((SHARED / "profiles.copilot.json", ROOT / plugin / "profiles.copilot.json"))
    for plugin in ALL_PLUGINS:
        for source in sorted((ROOT / "runtime").glob("*")):
            if source.is_file():
                pairs.append((source, ROOT / plugin / "runtime" / source.name))
        for name in PYTHON_CORE:
            pairs.append((ROOT / "src/taskshape" / name, ROOT / plugin / "runtime/taskshape" / name))
    return pairs


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
    if stale:
        print("out of sync:\n  " + "\n  ".join(stale))
        return 1
    print("ok" if check else "synced %d files" % len(plan()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
