# taskshape plugin for Claude Code

Routes every sub-agent launch: a function hook on the `Agent` tool classifies the task's shape and
picks the cheapest adequate model. With no configuration it rewrites the launch's `model` (`enforce`
mode) from built-in Claude profiles (haiku for lookup and routine work, sonnet for demanding and visual
work, opus for coupled, review and architecture work) and logs every decision; `suggest` mode only logs.
It never blocks a launch: if anything fails, the launch goes through unchanged and the status line says
why.

No Python needed. The rubric and the policy table are embedded in the plugin; the Python package
is an optional upgrade (Laya classifier, lab, MCP server).

Requires Claude Code 2.1.289 or later (function hooks).

## Install (two commands)

```bash
claude plugin marketplace add AlexandreRra/taskshape
claude plugin install taskshape@taskshape
```

From a local clone: `claude plugin marketplace add /path/to/taskshape` then the same install; the
plugin is then read from the folder, so edits apply after `/reload-plugins`.

Nothing else to set: routing is on. Decisions go to `~/.taskshape/decisions.jsonl` (or
`$CLAUDE_PLUGIN_DATA`), outcomes to `~/.taskshape/outcomes.jsonl`. To only observe for a while:

```
/plugin configure taskshape@taskshape      # mode -> suggest
```

Decision and outcome entries contain routing metadata; task prompts and descriptions are excluded from
those fields. Logs from earlier versions may still contain task descriptions.

## Options (all optional)

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `enforce` | `enforce` rewrites the Agent tool's `model` to the chosen profile's alias; `suggest` only logs. |
| `profiles` | built-in | Path to a `profiles.json` (same schema as the Python side) to replace the built-in table. |
| `budget` | `default` | Budget name from the profiles (`economy`, `standard`, `default` built in). |
| `command` | empty | Path to the Python `taskshape` CLI; when set, Laya (if adopted) classifies instead of the rubric, with the rubric as fallback. |
| `config` | empty | `taskshape.json` naming the adopted checkpoint; only with `command`. |
| `decisions` / `records` | `~/.taskshape/*.jsonl` | Where the audit trail and outcomes go. |
| `respectExplicitModel` | `true` | A launch that already names a model is left alone. |

## What it can and cannot change

- The Agent tool takes a model alias (`sonnet`, `opus`, `haiku`, `fable`) and no effort field: the
  plugin maps the profile's model id to an alias and only reports the effort. A profile whose model
  is not a Claude model is reported and left unchanged.
- Forks always inherit the parent model and are skipped.
- An outcome counts as accepted when the tool call did not error; better signals (review verdicts,
  tokens) can be added through `taskshape record` or the MCP `record` tool.

## Upgrade path

`pip install taskshape[laya,mcp]` (or the repo's venv) and set `command` to the CLI. Then
`taskshape lab ...` fine-tunes Laya on your own briefs, `taskshape report` reads the outcome records
the plugin wrote, and `claude mcp add taskshape -- taskshape-mcp --profiles ...` exposes
`route`/`record`/`report` to the orchestrator.

## Tests

```bash
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```

`hooks/rubric.test.ts` mirrors `tests/test_core.py` so the TypeScript and Python rubrics stay in step.
