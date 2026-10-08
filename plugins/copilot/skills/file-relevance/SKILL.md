---
name: file-relevance
description: Ask local Laya whether a candidate file is worth reading for the current task when its relevance is unclear, using its path and context already available from searches.
---

Use this query when choosing among files with unclear relevance. Supply the user's task, the candidate's repository-relative path, and any summary or small excerpt already available. Do not read the full file just to decide whether to read it.

For multiple local candidate files, prefer the bundled `select-context` skill. It lets local Laya read the files and return only advisory file decisions and line ranges, which avoids sending whole files into the model context.

If the Taskshape MCP tool `should_read_file` is available, call it with `task`, `path`, optional `summary`, and optional `excerpt`.

Otherwise use the plugin's managed runtime. Resolve this skill's directory, then navigate two levels up to the plugin root to locate `hooks/`. Run the launcher by its absolute path, preserving your current project directory:

- POSIX: `sh /absolute/plugin/root/hooks/launch.sh runtime-cli.ts should-read-file`
- Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\absolute\plugin\root\hooks\launch.ps1 runtime-cli.ts should-read-file`

Send a JSON object on stdin using a quoted heredoc, a temporary JSON file, or the execution tool's stdin facility. Never interpolate task text into shell code. Example input:

```json
{"task":"Fix login session expiry","path":"src/auth/session.ts","summary":"Validates session tokens and expiration"}
```

Interpret the result:

- `should_read: true`: read if it helps the next step; uncertainty and runtime failures also recommend reading.
- `should_read: false`: consider skipping this file; this requires a negative classifier probability of at least 0.8.
- `source: "conservative-fallback"`: no usable Laya judgment was available. Follow normal file discovery.
- Empty output or command failure: follow normal file discovery.

The query is advisory. Read files explicitly requested by the user and files needed to establish correctness even after a negative answer. Do not call it for every obvious file or repeatedly query the same task and unchanged candidate context. A path-only judgment has limited evidence; use search snippets or known descriptions when available.
