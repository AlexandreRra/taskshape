# taskshape plugin for GitHub Copilot CLI

Routes eligible Copilot CLI `task` launches. A `preToolUse` hook classifies the task shape, applies the configured Copilot profile table, and either rewrites `model` plus `reasoning_effort` in `enforce` mode or records the decision in `suggest` mode. A `subagentStop` hook records the outcome.

The default backend is a managed local Laya runtime. Set `backend` to `heuristic` in `~/.taskshape/copilot.json` or set `TASKSHAPE_BACKEND=heuristic` to use the embedded rule-based classifier. If routing cannot run, the task launch continues unchanged and the plugin records a skipped decision.

Requires a working Copilot CLI login. The plugin reuses an existing Node 22.6+ executable when one is available, or downloads pinned Node 22.23.3 into its private cache. No system Python is required for the default runtime.

## Install

```bash
copilot plugin install AlexandreRra/taskshape:plugins/copilot
```

From a local clone, for one session:

```bash
copilot --plugin-dir /path/to/taskshape/plugins/copilot
```

On the first session, the plugin writes `~/.taskshape/copilot.json` with default settings. Decisions go to `~/.taskshape/decisions.jsonl` and outcomes go to `~/.taskshape/outcomes.jsonl`. Set `TASKSHAPE_HOME` to move that folder.

To observe before rewriting launches, edit `~/.taskshape/copilot.json`:

```json
{ "mode": "suggest", "budget": "standard" }
```

Decision and outcome entries contain routing metadata; task prompts and descriptions are excluded from audit fields. Logs from earlier versions may still contain task descriptions.

## Runtime setup

The `sessionStart` hook starts managed runtime setup in the background when the default `laya` backend is enabled. It writes status to stderr. Setup uses:

- existing Node 22.6+ or pinned private Node 22.23.3;
- pinned `uv` 0.12.23;
- managed Python 3.12.11;
- pinned hash-checked CPU dependencies;
- multilingual Laya base model files from a pinned Hugging Face revision.

The large model file is about 650 MB, and the Python/PyTorch runtime can use several GB of disk. First setup needs network, disk space, and time. POSIX hosts need `sh`, `tar`, `curl` or `wget`, and a SHA-256 helper such as `sha256sum`, `shasum`, or `openssl`. Windows hosts need PowerShell and `tar`. If setup is still running or fails, the plugin keeps the original Copilot launch. Once the TypeScript hook can run, classifier failures are logged as skipped routing decisions. During Node bootstrap, the visible evidence may only be stderr/status text. Later classification runs locally in a short-lived Python process over stdin, with no server port, no provider call, and offline Hugging Face/Transformers settings. The default checkpoint is not a task-specialized fine-tune; no task-specialized checkpoint has passed the adoption gate yet.

## Configuration

Environment variables override the config file.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` / `TASKSHAPE_MODE` | `enforce` | `enforce` rewrites launches; `suggest` only logs. |
| `backend` / `TASKSHAPE_BACKEND` | `laya` | `laya` uses the managed local runtime; `heuristic` uses the embedded rubric. |
| `budget` / `TASKSHAPE_BUDGET` | `default` | Budget name from the profile table. |
| `profiles` / `TASKSHAPE_PROFILES` | shipped table | Path to a replacement profiles file. |
| `command` / `TASKSHAPE_COMMAND` | empty | Advanced override: path to a Python `taskshape` CLI command. When set, the hook calls that command instead of the managed runtime. |
| `config` / `TASKSHAPE_CONFIG` | empty | `taskshape.json` for the external command path. |
| `respectExplicitModel` / `TASKSHAPE_RESPECT_EXPLICIT_MODEL` | `true` | A launch that already names a model is left unchanged. |
| `discoverModels` | `true` | Refreshes a local model catalog through the Copilot CLI ACP server when available. |

## Model discovery

On session start, and once a day after that, the hook asks the Copilot CLI ACP server which models the account offers. It caches the result in `~/.taskshape/models.json`, including display names and usage multipliers when available. Routing then filters out profiles whose models are unavailable.

If discovery is missing or fails, routing uses the last good cached catalog when possible or the shipped model information otherwise. Set `discoverModels` to `false` to disable refreshes. Set `copilot` to another CLI executable when needed: it is a single executable name or path (no arguments), resolved through PATH and PATHEXT on Windows, and is not started through a shell. `TASKSHAPE_DISCOVERY_TIMEOUT_MS` bounds discovery time.

## Profiles

`profiles.copilot.json` lists model ids as the Copilot `task` tool accepts them, with capability, cost tier, phases, and the reasoning effort to request. Edit or replace the table to match the models your plan can call. A model rejected by the host still fails that launch, so keep the profile table aligned with your account.

Cost tiers are policy ordering values in the profile table. They are not live pricing.

## What it can and cannot change

- In `enforce` mode, the hook returns `permissionDecision: "allow"` with `modifiedArgs.model` and, when non-default, `modifiedArgs.reasoning_effort`.
- A launch that already names a model is left unchanged by default.
- Routing can only choose among profiles that remain after budget, phase, allowed-profile, and discovered-availability filters.
- `subagentStop` records `accepted` from `stopReason === "end_turn"`.

## VS Code

VS Code has two different Copilot surfaces:

- Copilot CLI sessions inside VS Code use the CLI engine and this plugin.
- VS Code agent mode uses the `runSubagent` hook shape and needs the sibling [VS Code plugin](../vscode/README.md).

Installing both plugins is safe; their hook payloads are different.

## Tests

```bash
node --experimental-strip-types --test plugins/copilot/hooks/harness.test.ts
```

Everything under `hooks/` is a copy of [plugins/shared](../shared) and is checked by `scripts/sync-shared.py --check` in the Python test suite.
