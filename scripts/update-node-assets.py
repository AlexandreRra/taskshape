#!/usr/bin/env python3
"""Refresh runtime/node-assets.tsv from Node's official latest-v22.x SHASUMS256.txt."""
from __future__ import annotations

from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "runtime" / "node-assets.tsv"
BASE = "https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt"
PLATFORMS = {
    "linux-x64": "linux-x64.tar.xz",
    "linux-arm64": "linux-arm64.tar.xz",
    "darwin-x64": "darwin-x64.tar.xz",
    "darwin-arm64": "darwin-arm64.tar.xz",
    "win-x64": "win-x64.zip",
    "win-arm64": "win-arm64.zip",
    "win-x86": "win-x86.zip",
}


def main() -> int:
    text = urlopen(BASE, timeout=30).read().decode("utf-8")
    sums = {}
    version = None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[1].startswith("node-v22."):
            continue
        sha, filename = parts
        sums[filename] = sha
        version = filename.split("-")[1].removeprefix("v")
    if not version:
        raise SystemExit("No Node v22 release entries found")
    lines = ["# platform\tversion\tfilename\tsha256"]
    for platform, suffix in PLATFORMS.items():
        filename = f"node-v{version}-{suffix}"
        sha = sums.get(filename)
        if not sha:
            raise SystemExit(f"Missing {filename}")
        lines.append(f"{platform}\t{version}\t{filename}\t{sha}")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} for Node {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
