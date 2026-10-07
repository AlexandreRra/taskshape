# Design

## Problem

An agent harness (Claude Code, Codex, a custom supervisor) launches many bounded tasks: a one-line
label fix, a save-format migration, a plan critique. Sending all of them to the most capable model
wastes money; sending all of them to the cheapest one wastes repairs. A human picks by feel; a
harness needs a rule it can explain and a way to learn from outcomes.

## Two decisions

1. **Shape classification.** Laya (a 421M-parameter non-autoregressive decision model) reads the task
   brief and one short criterion per shape and returns a probability per shape. Shapes are stable:

   | shape | required capability | typical cue |
   | --- | --- | --- |
   | lookup | 0 | find an exact file, string, value |
   | routine | 1 | approved plan, clear acceptance, few files, test-only or docs-only |
   | demanding | 2 | bounded but the cause is unknown, several steps, must verify |
   | visual | 2 (+vision) | screenshots, mockups, layouts, assets |
   | coupled | 3 | persistence, migrations, concurrency, security, several systems, root cause |
   | review | 3 | independent read-only acceptance of a bounded change |
   | architecture | 4 | design decisions, specs, disputes, escalation after failures |

2. **Policy table.** A deployment lists its authorized profiles (`model + effort`) with a capability
   class (0-4), a cost tier, allowed phases and flags such as `vision`. Under a budget (max cost tier)
   the policy picks the cheapest adequate profile; if nothing adequate fits the budget it picks the
   most capable within budget and warns `under-provisioned`. Every decision carries the reason.

Laya never sees model names, so a model swap is a table edit, not a retrain.

## Learning loop

`taskshape record` appends what actually happened: shape, profile, accepted or not, tokens, seconds.
`taskshape report` aggregates acceptance and cost per shape and profile and suggests, per shape, the
cheapest profile that already holds an acceptance rate above a threshold with enough samples. That
suggestion is a table edit a human approves, not an automatic change.

## Lab discipline

The classifier is only as good as its labels. The lab:

- builds a dataset from your briefs, labelled by hand or by the transparent rubric (`rubric.py`),
  as soft targets (0.70 on the label, decaying with capability distance);
- splits held-out rows by template (unseen phrasing), never by row;
- evaluates accuracy, mean answer confidence and expected calibration error per split;
- fine-tunes the top encoder layers plus the decision head (RLCD loss as upstream, bf16 autocast,
  fp32 loss), then calibrates temperature against the gold label;
- adopts a checkpoint only if accuracy never drops on any held-out split, the candidate was trained
  on the same dataset build the held-out splits came from, and it did not become over-confident.

## Evidence from the first deployment (TinyTames, 2026-10-04)

Before: Laya choosing directly among profiles with 5-word criteria agreed with the project's own
allocation policy on 50% of held-out real decisions (mean confidence 0.41, essentially uniform).
After a research-backed catalog, 48-token criteria and a 5-minute fine-tune on 336 labelled rows
(RTX 3050, 3.6 GB VRAM): 68% on held-out real decisions and 54% on briefs from unseen templates,
with better calibration (ECE 0.126 and 0.049). That deployment still asks Laya for the profile
directly; this project moves the profile choice into the policy table.

## Limits

- Laya's base checkpoint was trained on four synthetic business domains; without a domain dataset
  it is near random on engineering briefs. A few hundred labelled briefs are enough to make it useful.
- Shape accuracy is not provider quality. Prices and strengths come from the catalog and must be
  refreshed; acceptance rates come from your own records.
- The router sees the brief only. Briefs that cite sources or negate changes ("no save changes")
  confuse keyword rubrics; the rubric strips citations and negated clauses, imperfectly.
- Routing on CPU takes a few seconds per decision; fine-tuning wants a GPU with about 4 GB.

## Harness matrix (verified 2026-10-06; VS Code rows from the shipped bundles, not a live run)

| Harness | Intercept point | Can rewrite | Effort | Outcome signal | Install |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.289+ | function hook `tool.call` on `Agent` | `model` alias (`sonnet/opus/haiku/fable`), `subagent_type` | no field | tool result `isError`, seconds | marketplace, two commands |
| Copilot CLI 1.0.92 | `preToolUse` on `task` (`permissionDecision: allow` + `modifiedArgs`) | `model` id, `reasoning_effort`, `context_tier` | yes | `subagentStop` (`stopReason`, response) | `copilot plugin install owner/repo:plugins/copilot` |
| VS Code 1.140 agent mode (Copilot Chat 0.68 built in) | `PreToolUse` on `runSubagent` (`hookSpecificOutput.updatedInput` replaces the input) | `model` as `"Model Name (copilot)"`, `agentName`; VS Code refuses a sub-agent whose usage multiplier exceeds the main model's | no field | `SubagentStop` (no stop reason) | `plugins/vscode` (`taskshape-vscode`): Claude-layout plugin, `${CLAUDE_PLUGIN_ROOT}` token, `bash`/`powershell` pre-filters because the matcher is ignored; `SessionStart` records the main model for the multiplier ceiling. Verified against the bundle's payloads offline; not yet run inside VS Code |
| VS Code Copilot CLI sessions (bundled `@github/copilot/sdk` 1.0.73) | same SDK hook engine as the CLI: `preToolUse` + `modifiedArgs` | `model`, `reasoning_effort` (bundled engine lags the CLI; not exercised live there) | yes | `subagentStop` | `plugins/copilot` from `~/.copilot/installed-plugins` loads unchanged |
| Codex | spawn fields `model`, `reasoning_effort` | by instruction, no hook found | yes | by instruction | not built yet |

