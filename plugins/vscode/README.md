# taskshape plugin for VS Code agent mode

Routes eligible VS Code `runSubagent` launches in Copilot Chat agent mode. A `PreToolUse` hook classifies the task shape, applies the configured Copilot profile table, and either rewrites `model` in `enforce` mode or records the decision in `suggest` mode. A `SessionStart` hook records the main model and starts runtime setup. A `SubagentStop` hook records the outcome with `accepted: null` because VS Code does not expose a stop reason.

The default backend is a managed local Laya runtime. Set `backend` to `heuristic` in `~/.taskshape/copilot.json` or set `TASKSHAPE_BACKEND=heuristic` to use the embedded rule-based classifier. If routing cannot run, the subagent launch continues unchanged and the plugin records a skipped decision.

Requires GitHub Copilot access and VS Code with agent plugin support. The plugin reuses Node 22.6+ on the PATH VS Code sees or downloads pinned Node 22.23.3 into its private cache. No system Python is required for the default runtime.

## Install

Add the repository as a plugin marketplace and install `taskshape-vscode` from the Extensions view:

1. Settings:

   ```json
   {
     "chat.plugins.enabled": true,
     "chat.plugins.marketplaces": ["AlexandreRra/taskshape"]
   }
   ```

2. Extensions view, search `@agentPlugins taskshape`, then install **taskshape-vscode**.

VS Code asks you to trust a new marketplace. This plugin runs local hooks with the editor's permissions; review the source before granting trust. See [VS Code's agent plugin documentation](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

From a local clone:

```json
{ "chat.plugins.marketplaces": ["file:///path/to/taskshape"] }
```

On the first session, the plugin writes `~/.taskshape/copilot.json` with default settings. Decisions go to `~/.taskshape/decisions.jsonl` and outcomes go to `~/.taskshape/outcomes.jsonl`. Set `TASKSHAPE_HOME` to move that folder.

To observe before rewriting launches, edit `~/.taskshape/copilot.json`:

```json
{ "mode": "suggest", "budget": "standard" }
```

Decision and outcome entries contain routing metadata; task prompts and descriptions are excluded from audit fields. Logs from earlier versions may still contain task descriptions.

## Runtime setup

The `SessionStart` hook starts managed runtime setup in the background when the default `laya` backend is enabled. It writes status to stderr and adds the status as VS Code `additionalContext`. Setup uses:

- existing Node 22.6+ or pinned private Node 22.23.3;
- pinned `uv` 0.12.23;
- managed Python 3.12.11;
- pinned hash-checked CPU dependencies;
- multilingual Laya base model files from a pinned Hugging Face revision.

The large model file is about 650 MB, and the Python/PyTorch runtime can use several GB of disk. First setup needs network, disk space, and time. POSIX hosts need `sh`, `tar`, `curl` or `wget`, and a SHA-256 helper such as `sha256sum`, `shasum`, or `openssl`. Windows hosts need PowerShell and `tar`. If setup is still running or fails, the plugin keeps the original VS Code launch. Once the TypeScript hook can run, classifier failures are logged as skipped routing decisions. During Node bootstrap, the visible evidence may only be stderr/status text. Later classification runs locally in a short-lived Python process over stdin, with no server port, no provider call, and offline Hugging Face/Transformers settings. The default checkpoint is not a task-specialized fine-tune; no task-specialized checkpoint has passed the adoption gate yet.

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
| `routeNamedAgents` / `TASKSHAPE_ROUTE_NAMED_AGENTS` | `false` | Named custom agents are skipped unless this is enabled. |
| `discoverModels` | `true` | Refreshes a local model catalog through the Copilot CLI ACP server when available. |

## Model discovery

At session start, and once a day after that, the hook can ask the Copilot CLI ACP server which models the account offers. This needs the Copilot CLI on the PATH VS Code sees; VS Code's bundled engine is not a CLI. The result is cached in `~/.taskshape/models.json`, including display names and usage multipliers when available.

If discovery is missing or fails, routing uses the last good cached catalog when possible or the shipped model information otherwise. Set `discoverModels` to `false` to disable refreshes. Set `copilot` to another CLI executable when needed: it is a single executable name or path (no arguments), resolved through PATH and PATHEXT on Windows, and is not started through a shell. `TASKSHAPE_DISCOVERY_TIMEOUT_MS` bounds discovery time.

## What VS Code lets a hook do

- `runSubagent` uses display names such as `"Model Name (copilot)"`, so the profiles file maps provider model ids to VS Code display names.
- VS Code can reject a sub-agent model whose usage multiplier exceeds the main model's. The plugin caps eligible profiles by the recorded session model multiplier. Unknown main models get a 1x ceiling; `Auto` has no ceiling.
- There is no reasoning-effort field, so the plugin changes only the model.
- Launches that already name a model are left unchanged by default.
- Named custom agents are skipped by default because they may pin their own model in `.agent.md`.
- `SubagentStop` exposes no stop reason; outcomes are recorded with `accepted: null`.
- In `suggest` mode the outcome records `profile: null`, `model: inherited` and the proposed profile in `suggested_profile`, so reports do not credit a profile that never ran.
- A `budget` name missing from the profile table skips routing: the launch keeps its original model and the error is logged in `decisions.jsonl`. Only `default` falls back to the widest ceiling when the table does not define it.
- An outcome is attributed to a launch only when exactly one pending launch fits the stop. A stop from another session with several VS Code launches pending is logged as not attributed and consumes nothing; VS Code gives no id that ties a stop to its launch for certain. Pending launches older than 6 hours are discarded.
- Suggest mode logs decisions without returning hook output.

Hook behavior is tested against captured VS Code payloads and outputs, including installed folders with spaces and encoded characters and checks that prompts and descriptions stay out of audit files. A live Copilot routing session inside VS Code is still pending.

## Copilot CLI sessions inside VS Code

Copilot CLI terminal sessions inside VS Code use the CLI engine. Install the sibling [Copilot CLI plugin](../copilot/README.md) for those sessions:

```bash
copilot plugin install AlexandreRra/taskshape:plugins/copilot
```

VS Code may discover plugins installed by the Copilot CLI, but this plugin and the CLI plugin handle different hook payloads.

## Tests

```bash
node --experimental-strip-types --test plugins/vscode/hooks/harness.test.ts
```

Everything under `hooks/` except `hooks.json` is a copy of [plugins/shared](../shared) and is checked by `scripts/sync-shared.py --check` in the Python test suite. The [CI workflow](../../.github/workflows/ci.yml) also runs these tests on Linux, Windows, and macOS.
