# taskshape plugin for VS Code agent mode

Routes every sub-agent launch made through VS Code's `runSubagent` tool (the Local harness, the default
agent mode of Copilot Chat): a `PreToolUse` hook classifies the task's shape and picks the cheapest
adequate Copilot model from the shipped multi-provider profile table. `suggest` mode logs the decision;
`enforce` mode rewrites the launch's `model` through `hookSpecificOutput.updatedInput`, which VS Code
applies before the tool runs. A `SessionStart` hook remembers the session's main model and a
`SubagentStop` hook records the outcome. Nothing is ever blocked: on any failure the launch goes through
unchanged.

Needs GitHub Copilot access, VS Code with agent plugin support, and Node 22.6+ on the PATH VS Code sees
(the hooks run with `--experimental-strip-types`; no Python needed).

## Install

Add the repository as a plugin marketplace and install `taskshape-vscode` from the Extensions view:

1. Settings:

   ```json
   {
     "chat.plugins.enabled": true,
     "chat.plugins.marketplaces": ["AlexandreRra/taskshape"]
   }
   ```

2. Extensions view, search `@agentPlugins taskshape`, install **taskshape-vscode**.

VS Code asks you to trust a new marketplace. This plugin runs local hooks with the editor's permissions;
review the source before granting trust. See [VS Code's agent plugin documentation](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

From a local clone: `"chat.plugins.marketplaces": ["file:///path/to/taskshape"]`.

That is the whole setup: routing is on from the first session, which writes `~/.taskshape/copilot.json`
with every setting at its default and a note explaining each (`enforce` mode, `default` budget, the shipped
`profiles.copilot.json`); decisions go to `~/.taskshape/decisions.jsonl` and outcomes to
`~/.taskshape/outcomes.jsonl` (set `TASKSHAPE_HOME` to move the folder). To only observe for a while, or
to pick a budget, edit that file (shared with the Copilot CLI plugin; it is never overwritten):

```json
{ "mode": "suggest", "budget": "standard" }
```

Decision and outcome entries contain routing metadata; task prompts and descriptions are excluded from
those fields. Logs from earlier versions may still contain task descriptions.

Environment variables override the file: `TASKSHAPE_MODE`, `TASKSHAPE_BUDGET`, `TASKSHAPE_PROFILES`,
`TASKSHAPE_COMMAND` (path to the Python `taskshape` CLI, for Laya), `TASKSHAPE_CONFIG`,
`TASKSHAPE_RESPECT_EXPLICIT_MODEL`, `TASKSHAPE_ROUTE_NAMED_AGENTS`.

## Model discovery

At session start, and once a day after that, the `SessionStart` hook asks the Copilot CLI's own ACP server (`copilot --acp`: `initialize` then `session/new`, no model call, about a second) which models
the account offers, with their display names and usage multipliers, and caches the answer in
`~/.taskshape/models.json`. Routing then only considers profiles whose model the account offers, so a launch
never names a model VS Code would refuse to resolve; the discovered names and multipliers also replace the
shipped `models` map. Every decision records the catalog it used (`catalog`) and the profiles it set aside
(`unavailable_profiles`). This needs the Copilot CLI on the PATH VS Code sees (`npm install -g @github/copilot`); VS Code's bundled
engine is not a CLI. When the CLI is missing or fails, the shipped table is used unchanged and discovery
is retried after an hour; a failed refresh keeps the last good list. `"discoverModels": false` turns it off,
`"copilot"` points at another CLI executable, `TASKSHAPE_DISCOVERY_TIMEOUT_MS` (default 7000) bounds the
wait. Each discovery leaves one ordinary, never-prompted session entry under `~/.copilot`.

## What VS Code lets a hook do (read from VS Code 1.140.0, Copilot Chat 0.68.0)

- `runSubagent` takes `prompt`, `description`, optional `agentName` and optional `model` written as
  `"Model Name (copilot)"`; VS Code resolves it by display name, so `profiles.copilot.json` carries a
  `models` map from the ids the Copilot CLI uses to those names.
- A sub-agent may not use a model whose usage multiplier exceeds the main model's; VS Code refuses the
  launch otherwise. The `SessionStart` hook records the main model and `PreToolUse` only picks profiles
  within that ceiling (unknown main model: assumed 1x; `Auto`: no ceiling). The multipliers come from the
  daily discovery above; the shipped `models` map (read from this account on 2026-10-06) is the fallback.
- There is no reasoning-effort field, so only the model changes.
- A launch that already names a `model` is left alone (`respectExplicitModel`), and so is a launch of a
  named custom agent, which may pin its own model in its `.agent.md` (`routeNamedAgents: true` routes
  those too).
- VS Code runs every `PreToolUse` hook for every tool call (the `matcher` is not applied), so the
  `bash`/`powershell` entries pre-filter on the payload text and only start Node for `runSubagent`.
- `SubagentStop` exposes no stop reason; outcomes are recorded with `accepted: null` there.
- Suggest mode prints nothing (VS Code warns about non-JSON hook output).

Hook behavior is tested against payloads and outputs read from the VS Code bundle, including installed
folders with spaces and encoded characters and checks that prompts and descriptions stay out of audit
files. A live Copilot routing session inside VS Code is still pending.

## Copilot CLI sessions inside VS Code

Those sessions (`Chat: New Copilot CLI Session`, the "GitHub Copilot CLI" terminal profile) run the
Copilot CLI engine, not this harness. Install the sibling plugin for them:
`copilot plugin install AlexandreRra/taskshape:plugins/copilot`. VS Code also discovers plugins installed
by the Copilot CLI, but that plugin's `exec` hooks are inert in agent mode, so the two never route the
same launch twice.

## Tests

```bash
node --experimental-strip-types --test plugins/vscode/hooks/harness.test.ts
```

Everything under `hooks/` except `hooks.json` is a copy of `plugins/shared/` (kept identical by
`scripts/sync-shared.py --check`, run by the Python test suite).

The [CI workflow](../../.github/workflows/ci.yml) also runs these tests on Linux, Windows and macOS.
