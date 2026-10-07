# taskshape

Cost-aware model routing for agent harnesses: classify the **shape** of a task with a small local
decision model ([Laya](https://huggingface.co/convaiinnovations/laya)), then let a transparent policy
table pick the cheapest model and effort level whose capability covers that shape.

Status: early scaffold extracted from a working deployment (the TinyTames supervisor), not yet a
released package. Working name; license Apache-2.0 (same as Laya).

## Why two decisions instead of one

Models change every month; task shapes do not. Training a classifier on *which model to call*
means retraining whenever the lineup moves. Training it on *what kind of task this is* and keeping
the model choice in a dated, editable table means:

- the routing decision is inspectable (`shape -> profile`, with the reason printed);
- cost-benefit lives in data (price per token, acceptance rate per shape and profile), not in the weights;
- the classifier can be fine-tuned once per domain on a few hundred labelled briefs and reused.

Shapes (`src/taskshape/shapes.py`): `lookup`, `routine`, `demanding`, `coupled`, `review`,
`architecture`, `visual`, each with a required capability class 0-4.

## Pieces

| Piece | What it does |
| --- | --- |
| `catalog/models.json` | Dated, source-linked notes on current models: positioning, strengths, weaknesses, prices, effort levels. Edit when the market moves. |
| `catalog/profiles.example.json` | A deployment's authorized `model + effort` profiles with a capability class, a cost tier, phases and flags. Copy and edit per installation. |
| `taskshape route` | Classifies the task (Laya checkpoint, or a regex rubric as fallback) and applies the policy table under a budget. Prints the decision as JSON with probabilities, reason and warnings. |
| `taskshape record` / `report` | Append execution outcomes (accepted, tokens, seconds) and summarize acceptance and cost per shape and profile, suggesting cheaper tiers that already hold up. |
| `taskshape lab` | Build a labelled dataset from your own briefs, evaluate a checkpoint on held-out splits, fine-tune Laya locally (GPU with ~4 GB is enough), compare and adopt a checkpoint only when it does not regress. |

No provider is ever called by this package. Routing runs offline on CPU in a few seconds; the
network is only needed to download the base Laya checkpoint once.

## Plug and play (Claude Code)

```bash
claude plugin marketplace add AlexandreRra/taskshape
claude plugin install taskshape@taskshape
```

That is the whole install. The plugin ships its own rubric and a built-in Claude profile table, so it
routes every sub-agent launch immediately (`enforce` mode; decisions in `~/.taskshape/decisions.jsonl`,
outcomes in `~/.taskshape/outcomes.jsonl`). `/plugin configure taskshape@taskshape` switches it to
`suggest`, which only logs. No Python needed; see `plugins/claude-code/README.md`.

## Plug and play (GitHub Copilot CLI)

```bash
copilot plugin install AlexandreRra/taskshape:plugins/copilot
```

A `preToolUse` hook on Copilot's `task` tool routes every sub-agent launch across every provider
your plan offers (OpenAI, Anthropic, Google, xAI, Moonshot, Microsoft) and, in `enforce` mode,
rewrites both `model` and `reasoning_effort`; a `subagentStop` hook records the outcome. The first session
writes `~/.taskshape/copilot.json` with the defaults (`enforce`; set `mode` to `suggest` there to only observe)
and discovers which models the account offers through the CLI's own ACP server (no model call), so routing
never names a model the plan lacks. Needs Node 22.6+ only.
See `plugins/copilot/README.md`.

## Plug and play (VS Code agent mode)

```json
{ "chat.plugins.marketplaces": ["AlexandreRra/taskshape"] }
```

Then install **taskshape-vscode** from the Extensions view (`@agentPlugins taskshape`). A `PreToolUse`
hook on VS Code's `runSubagent` tool routes every sub-agent launch and, in `enforce` mode, rewrites the
model through `updatedInput`, staying within VS Code's rule that a sub-agent may not cost more than the
main model. It shares `~/.taskshape/copilot.json` with the Copilot CLI plugin (written on the first session,
`enforce` by default) and, with the Copilot CLI installed, the same daily discovery of the account's models.
Copilot CLI sessions started from VS Code use the Copilot CLI plugin above instead. Needs Node 22.6+ only. See `plugins/vscode/README.md`.

## Quick start (Python side: Laya, lab, MCP)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[laya]"          # core has no dependencies; the laya extra brings torch
taskshape validate --catalog catalog/models.json --profiles catalog/profiles.example.json
taskshape route --profiles catalog/profiles.example.json --budget standard \
    --task "Own payments/ledger.py and its tests; keep the v3 ledger format readable; migration must be idempotent"
```

Without a fine-tuned checkpoint the `heuristic` backend (a transparent regex rubric) is used and
the decision says so. To use Laya: `taskshape route --backend laya --checkpoint <dir> ...`.

## Fine-tuning on your own briefs

```bash
taskshape lab dataset --briefs briefs.jsonl --out lab/2026-10   # rows: {"task", "phase", "shape"?, "template"?}
taskshape lab eval --checkpoint <base> --dataset lab/2026-10/heldout.jsonl --out lab/2026-10/base.json
taskshape lab finetune --base <base> --train lab/2026-10/train.jsonl --out checkpoints/2026-10
taskshape lab eval --checkpoint checkpoints/2026-10 --dataset lab/2026-10/heldout.jsonl --out lab/2026-10/cand.json
taskshape lab adopt --config taskshape.json --checkpoint checkpoints/2026-10 \
    --baseline lab/2026-10/base.json --candidate lab/2026-10/cand.json --meta lab/2026-10/meta.json
```

`adopt` refuses a candidate that loses accuracy on any held-out split, that was evaluated on a
different dataset build than it was trained from, or that became over-confident.

## Harness integration

- **MCP server** (`taskshape-mcp`, stdio, started by the client, no network): tools `route`, `record`,
  `report`, `policy_table`. `claude mcp add taskshape -- /path/.venv/bin/taskshape-mcp --profiles profiles.json --config taskshape.json --records records/outcomes.jsonl`.
- **Claude Code plugin** (`plugins/claude-code`): a function hook on the `Agent` tool routes every
  sub-agent launch with an embedded rubric and built-in profiles; `suggest` mode logs, `enforce` mode
  rewrites the model; set `command` to hand classification to the Python CLI (Laya). See its README.
- **Copilot CLI plugin** (`plugins/copilot`): Node hooks (`sessionStart` discovers the account's models through
  `copilot --acp`, `preToolUse` on `task`, `subagentStop`) with the same embedded rubric; enforce mode rewrites `model` and `reasoning_effort`; `TASKSHAPE_COMMAND` hands
  classification to the Python CLI. Also serves Copilot CLI sessions inside VS Code. See its README.
- **VS Code plugin** (`plugins/vscode`): the same hook scripts behind VS Code's own hook contract
  (`PreToolUse` on `runSubagent` with `updatedInput`, `SessionStart`, `SubagentStop`); models are named
  as VS Code displays them and capped by the main model's usage multiplier. See its README.
- Other harnesses: the CLI prints JSON (`taskshape route --task ... --log decisions.jsonl`), so any
  hook that can run a process can call it.

See `docs/DESIGN.md` for the design and the evidence from the first deployment.
