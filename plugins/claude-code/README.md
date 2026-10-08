# taskshape plugin for Claude Code

Routes eligible `Agent` launches in Claude Code. A function hook classifies the task shape, applies the configured Claude profile table, and either rewrites the launch model in `enforce` mode or records the decision in `suggest` mode.

The default backend is a managed local Laya runtime. Set the plugin `backend` option to `heuristic` when you want the embedded rule-based classifier instead. If routing cannot run, the Agent launch continues unchanged and the hook reports the runtime status.

Requires Claude Code 2.1.289 or later. The plugin reuses an existing Node 22.6+ executable when one is available, or downloads pinned Node 22.23.3 into its private cache. No system Python is required for the default runtime.

## Install

```bash
claude plugin marketplace add AlexandreRra/taskshape
claude plugin install taskshape@taskshape
```

From a local clone, add the clone as the marketplace:

```bash
claude plugin marketplace add /path/to/taskshape
claude plugin install taskshape@taskshape
```

The plugin is then read from that folder; edits apply after `/reload-plugins`.

Decisions go to `~/.taskshape/decisions.jsonl` or `$CLAUDE_PLUGIN_DATA/decisions.jsonl`. Outcomes go to `~/.taskshape/outcomes.jsonl` or `$CLAUDE_PLUGIN_DATA/outcomes.jsonl`. Decision and outcome entries contain routing metadata; task prompts and descriptions are excluded from those audit fields. Logs from earlier versions may still contain task descriptions.

To observe routing without rewriting launches:

```text
/plugin configure taskshape@taskshape
```

Set `mode` to `suggest`.

## Runtime setup

With the default `laya` backend, the plugin prepares local runtime assets when classification first needs them:

- existing Node 22.6+ or pinned private Node 22.23.3;
- pinned `uv` 0.12.23;
- managed Python 3.12.11;
- pinned hash-checked CPU dependencies;
- multilingual Laya base model files from a pinned Hugging Face revision.

The large model file is about 650 MB, and the Python/PyTorch runtime can use several GB of disk. First setup needs network, disk space, and time. POSIX hosts need `sh`, `tar`, `curl` or `wget`, and a SHA-256 helper such as `sha256sum`, `shasum`, or `openssl`. Windows hosts need PowerShell and `tar`. While setup is still running, unsupported, or failed, Claude keeps the original launch and the plugin reports that routing was unavailable. Later classification runs locally in a short-lived Python process over stdin, with no server port, no provider call, and offline Hugging Face/Transformers settings. The default checkpoint is not a task-specialized fine-tune; no task-specialized checkpoint has passed the adoption gate yet.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `enforce` | `enforce` rewrites the Agent tool's `model` to the chosen Claude alias; `suggest` only logs. |
| `backend` | `laya` | `laya` uses the managed local runtime; `heuristic` uses the embedded rule-based classifier. |
| `profiles` | built-in | Path to a `profiles.json` with the same schema as the Python side. |
| `budget` | `default` | Budget name from the profiles (`economy`, `standard`, `default` built in). |
| `command` | empty | Advanced override: path to a Python `taskshape` CLI command. When set, the plugin calls that command instead of the managed runtime. |
| `config` | empty | `taskshape.json` for the external command path. |
| `decisions` / `records` | `~/.taskshape/*.jsonl` | Decision and outcome log paths. |
| `respectExplicitModel` | `true` | A launch that already names a model is left unchanged. |
| `routeNamedAgents` | `false` | Launches of a named subagent (any `subagent_type` other than `general-purpose` and `fork`) keep the model that agent pins; enable to route them too. |

## What it can and cannot change

- Claude Code's Agent tool accepts model aliases (`haiku`, `sonnet`, `opus`, `fable`) and no reasoning-effort field, so the plugin changes only the model alias.
- A profile whose model id cannot map to a Claude alias is reported and left unchanged.
- Explicit model launches are kept by default.
- Forks inherit the parent model and are skipped.
- Named subagents (for example `oh-my-claudecode:architect`) keep their own model unless `routeNamedAgents` is enabled; only launches without `subagent_type` or with `general-purpose` are routed.
- A profiles file that cannot be read or validated, or a `budget` name the profiles do not define, never rewrites the model: the launch stays unchanged, the decision is logged as `suggested` with a warning.
- In `suggest` mode (or when nothing was rewritten) the outcome record carries `profile: null` and the sibling `suggested_profile`, so reports do not credit an unexecuted profile.
- An outcome counts as accepted when the tool call did not error. Add richer review signals later with `taskshape record` or the MCP `record` tool.

## Python and MCP tools

The Python package is optional for this plugin. Use it when you want CLI routing, records, reports, MCP tools, or lab workflows:

```bash
pip install -e ".[mcp,laya]"
claude mcp add taskshape -- taskshape-mcp --profiles catalog/profiles.example.json --catalog catalog/models.json --backend heuristic
```

The lab can fine-tune and evaluate local Laya checkpoints from labelled briefs. Adopted checkpoints are consumed by the Python CLI/MCP path; the plugin's default managed runtime uses the pinned public multilingual Laya base checkpoint.

## Tests

```bash
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```

The TypeScript hook tests cover routing behavior and audit-field exclusions for task prompts and descriptions.
