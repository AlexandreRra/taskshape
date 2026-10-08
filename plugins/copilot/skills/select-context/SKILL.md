---
name: select-context
description: Ask local Laya to inspect candidate files and return only the file decisions and useful line ranges for the current task.
---

Use this skill when several candidate files may or may not be worth reading, and reading all of them would add unnecessary context. Prefer search results, explicit user files, and correctness needs first; this query is advisory.

If the Taskshape MCP tool `select_context` is available, call it with `task`, `paths`, and optional flat options: `root`, `skip_threshold`, `max_file_bytes`, `chunk_lines`, `max_chunks`, and `batch_size`.

Otherwise use the plugin's managed runtime. Resolve this skill's directory, then navigate two levels up to the plugin root to locate `hooks/`. Run the launcher by its absolute path, preserving your current project directory:

- POSIX: `sh /absolute/plugin/root/hooks/launch.sh runtime-cli.ts select-context`
- Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\absolute\plugin\root\hooks\launch.ps1 runtime-cli.ts select-context`

Send JSON on stdin using a quoted heredoc, a temporary JSON file, or the execution tool's stdin facility. Never interpolate task text into shell code. Example input:

```json
{"task":"Fix login session expiry","paths":["src/auth/session.ts","src/billing/invoices.ts"]}
```

Default behavior is plug and play: omit options unless the task needs a different root or budget. Advanced options are bounded; defaults are `root` as the current project directory, `skip_threshold` `0.95`, `max_file_bytes` `262144`, `chunk_lines` `80`, `max_chunks` `64` across the whole request, and `batch_size` `8`. Send at most 20 paths per request.

Interpret the result:

- `should_read: true`: read the returned `ranges` first when present; if ranges are empty, use normal file discovery.
- `should_read: false`: consider skipping that file only when the decision does not conflict with user instructions or correctness needs.
- `complete: false`: do not treat a negative as authoritative. The bundled validator fails open for this case.
- `source: "conservative-fallback"`: no usable Laya judgment was available. Follow normal file discovery.
- Empty output or command failure: follow normal file discovery.

The model should not pre-read full files before calling this skill. Laya reads local files inside the managed runtime and returns only paths, booleans, line ranges, counts, and sanitized warnings. Explicit user files, files needed for correctness, and files named by failing diagnostics can override a skip recommendation.
