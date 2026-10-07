# taskshape plugin for GitHub Copilot CLI

Routes every sub-agent launch made through Copilot's `task` tool, in the terminal or in a Copilot CLI
session inside VS Code: a `preToolUse` hook classifies the task's shape and picks the cheapest adequate model **and reasoning effort** from a multi-provider
profile table (OpenAI, Anthropic, Google, xAI, Moonshot, Microsoft: whatever your plan offers).
`suggest` mode logs the decision; `enforce` mode rewrites `model` and `reasoning_effort` on the
launch, which Copilot honors (`taskModelSource: task_argument`). A `subagentStop` hook records the
outcome. Nothing is ever blocked: on any failure the launch goes through unchanged.

Needs Node 22.6+ (the hooks run with `--experimental-strip-types`; no install step, no Python).

## Install (one command)

```bash
copilot plugin install AlexandreRra/taskshape:plugins/copilot
```

From a local clone, for one session: `copilot --plugin-dir /path/to/taskshape/plugins/copilot`.

That is the whole setup: routing is on from the first session, which writes `~/.taskshape/copilot.json`
with every setting at its default and a note explaining each (`enforce` mode, `default` budget, the shipped
`profiles.copilot.json`); decisions go to `~/.taskshape/decisions.jsonl` and outcomes to
`~/.taskshape/outcomes.jsonl` (set `TASKSHAPE_HOME` to move the folder). To only observe for a while, or
to pick a budget, edit that file (shared with the VS Code plugin; it is never overwritten):

```json
{ "mode": "suggest", "budget": "standard" }
```

Environment variables override the file: `TASKSHAPE_MODE`, `TASKSHAPE_BUDGET`, `TASKSHAPE_PROFILES`,
`TASKSHAPE_COMMAND` (path to the Python `taskshape` CLI, for Laya), `TASKSHAPE_CONFIG`,
`TASKSHAPE_RESPECT_EXPLICIT_MODEL`. Hooks: `sessionStart` (the CLI runs it on the session's first prompt; it
writes the config and prunes old session files), `preToolUse` on `task`, `subagentStop`.

## Model discovery

On a session's first prompt, and once a day after that, the `sessionStart` hook asks the Copilot CLI's own
ACP server (`copilot --acp`: `initialize` then `session/new`, no model call, about a second) which models
the account offers, with their display names and usage multipliers, and caches the answer in
`~/.taskshape/models.json`. Routing then only considers profiles whose model the account offers, so a launch
never names a model the `task` tool would reject; the discovered names and multipliers also replace the
shipped `models` map. Every decision records the catalog it used (`catalog`) and the profiles it set aside
(`unavailable_profiles`). When the CLI is missing or fails, the shipped table is used unchanged and discovery
is retried after an hour; a failed refresh keeps the last good list. `"discoverModels": false` turns it off,
`"copilot"` points at another CLI executable, `TASKSHAPE_DISCOVERY_TIMEOUT_MS` (default 7000) bounds the
wait. Each discovery leaves one ordinary, never-prompted session entry under `~/.copilot`.

## Profiles

`profiles.copilot.json` lists sub-agent model ids as the `task` tool accepts them, with capability
class, cost tier (from GitHub's published per-token rates) and the reasoning effort to request.
Prune it to the models your plan shows in `/model`; a model the tool rejects fails that launch, so
only list what you can call. Frontier models (Opus 5.5, GPT-6 Astra/Sol, Fable 5.1) are not offered
to sub-agents on every plan; add them when the `task` tool lists them. Point `profiles` in
`copilot.json` to your own file to replace the table.

## What was verified (Copilot CLI 1.0.92, 2026-10-06)

- The `task` tool's arguments are `name`, `agent_type`, `description`, `prompt`, optional `model`,
  `reasoning_effort`, `context_tier`, `mode`.
- A `preToolUse` answer of `{"permissionDecision": "allow", "modifiedArgs": {...}}` replaces the
  arguments; the sub-agent then reports `taskModelSource: task_argument` and the requested effort.
  `modifiedArgs` alone, without `permissionDecision`, was not applied.
- Repository hooks (`.github/hooks`) load only from a trusted working directory
  (`COPILOT_ALLOW_ALL=true` trusts it); user hooks (`~/.copilot/hooks`) and plugin hooks always load.
- `subagentStop` carries `agentType`, `agentName`, `stopReason` and the response text.

## VS Code

VS Code runs Copilot in two harnesses:

- **Copilot CLI sessions** (`Chat: New Copilot CLI Session`, the "GitHub Copilot CLI" terminal
  profile) run the same engine as the CLI, bundled with the extension (`@github/copilot/sdk`). It reads
  `COPILOT_HOME` or `~/.copilot`: installed plugins, `~/.copilot/hooks`, and `.github/hooks` once the
  folder is trusted, and applies `modifiedArgs` from `preToolUse` the same way. This plugin therefore
  serves those sessions unchanged after `copilot plugin install`. The bundled engine lags the CLI
  (1.0.73 against 1.0.92 on the machine this was read from), so `model`/`reasoning_effort` on its `task`
  tool are expected but were not exercised live there.
- **Agent mode** (the Local harness, VS Code's own `runSubagent` tool) needs the sibling plugin
  `plugins/vscode` (`taskshape-vscode`): a different payload, a different output and display names
  instead of model ids. VS Code also discovers plugins installed by the Copilot CLI, but this plugin's
  `exec` hooks are inert there, so installing both never routes a launch twice.

## Tests

```bash
node --experimental-strip-types --test plugins/copilot/hooks/harness.test.ts
```

Everything under `hooks/` is a copy of `plugins/shared/` (kept identical by `scripts/sync-shared.py --check`,
run by the Python test suite); the same scripts serve the VS Code plugin.
