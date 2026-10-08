# Design

taskshape is a local routing layer for agent harnesses. It classifies a task brief into a small
shape taxonomy, then applies a profile table to choose a model/effort profile that the deployment is
allowed to use.

The router does not call model providers. The default classifier is a dependency-free rule-based
rubric. Laya is optional and only runs from a local checkpoint.

## Routing Flow

The Python router processes each request as follows:

1. A host hook, MCP client or CLI command sends a task brief to taskshape.
2. The classifier returns one shape and a probability distribution over the offered shapes.
3. The policy filters profiles by phase, required flags, allowed profile ids and budget.
4. The policy chooses the lowest cost-tier profile whose capability covers the shape.
5. The caller receives JSON with the shape, profile, model, effort, reason, warnings and considered
   profiles.

The main entrypoints are:

- [src/taskshape/cli.py](../src/taskshape/cli.py): `route`, `validate`, `record`, `report`, and `lab`.
- [src/taskshape/router.py](../src/taskshape/router.py): classifier selection and route result shape.
- [src/taskshape/policy.py](../src/taskshape/policy.py): profile filtering and selection.
- [src/taskshape/mcp_server.py](../src/taskshape/mcp_server.py): local stdio MCP tools.

## Shape Taxonomy

Shapes are intentionally separate from provider model names. A deployment can update model ids,
effort levels, prices or authorization without retraining a classifier.

| Shape | Capability | Meaning |
| --- | ---: | --- |
| `lookup` | 0 | Exact lookup, extraction or classification with no judgment. |
| `routine` | 1 | Small bounded edits, docs-only work, config changes or read-only discovery. |
| `demanding` | 2 | Single-subsystem work that needs several steps and verification. |
| `visual` | 2 | Screenshot, mockup, layout or image inspection; requires `vision: true`. |
| `coupled` | 3 | Persistence, migrations, concurrency, security boundaries, multiple systems or root-cause work. |
| `review` | 3 | Independent read-only review of a bounded change. |
| `architecture` | 4 | Planning, specification, critique, design disputes or broad reasoning. |

The source of truth is [src/taskshape/shapes.py](../src/taskshape/shapes.py). Work-phase routing can
return every shape except `review`; review-phase routing returns only `review` or `architecture`.

## Classifiers

The default backend is `heuristic`. It uses the local rubric in
[src/taskshape/rubric.py](../src/taskshape/rubric.py), returns soft probabilities, and requires no
runtime dependencies.

The CLI default is `--backend auto`: it uses the heuristic backend unless `--checkpoint` or a config
checkpoint is present, then it tries Laya. The `laya` backend loads a local checkpoint directory
containing `rl_agent_config.json`. It sets Hugging Face and Transformers offline environment variables
before importing Laya, so route-time classification is local.

If a backend prediction fails or returns an invalid distribution after the backend was created,
routing falls back to the heuristic backend and records a warning. Backend setup errors, invalid policy
inputs, unknown budgets, unknown `--allowed` profile ids or missing eligible profiles still return
errors.

## Profile Policy

A profiles file contains:

- `profiles`: authorized model/effort profiles with `id`, `model`, `effort`, `capability`,
  `cost_tier`, allowed `phases`, and optional flags such as `vision`.
- `budgets`: named maximum cost tiers such as `economy`, `standard` and `default`.

For a classified shape, [src/taskshape/policy.py](../src/taskshape/policy.py):

1. keeps only profiles for the current phase;
2. limits selection to explicitly allowed profile ids, if supplied (`--allowed` in the CLI);
3. removes profiles missing required flags such as `vision`;
4. keeps only profiles with `cost_tier <= max_cost_tier`;
5. chooses the lowest cost-tier profile whose capability covers the shape.

If profiles are eligible and within budget but none is capable enough, the policy chooses the most
capable profile within budget and adds an `under-provisioned` warning. If no profile is eligible or no
eligible profile fits the budget, routing fails instead of inventing a choice.

See [catalog/profiles.example.json](../catalog/profiles.example.json) for the schema in use and
[catalog/models.json](../catalog/models.json) for optional model notes and list-price data.

## Records and Reports

Routing decisions and execution outcomes are separate. Both are handled by
[src/taskshape/records.py](../src/taskshape/records.py).

- `taskshape route --log decisions.jsonl` appends a decision audit row.
- `taskshape record --file outcomes.jsonl ...` appends the result of a task after it ran.
- `taskshape report --file outcomes.jsonl ...` aggregates acceptance, mean cost and mean seconds by
  shape/profile.

Report suggestions are advisory. A report names the lowest cost-tier profile that meets the configured
sample and acceptance thresholds for a shape, but it does not edit profiles. A maintainer applies policy
changes by editing and validating the profiles file.

When a catalog is supplied and contains verified prices for a selected model, `record` estimates
`cost_usd` from input/output token counts. If prices are absent or unverified, cost remains `null`.

## Lab Workflow

The lab commands in [src/taskshape/lab.py](../src/taskshape/lab.py) support local Laya training and
adoption:

1. `taskshape lab dataset` reads JSONL briefs and writes `all.jsonl`, `train.jsonl`,
   `heldout.jsonl` and `meta.json`.
2. `taskshape lab eval` evaluates a checkpoint against one or more datasets and records accuracy,
   confidence, calibration and checkpoint hashes.
3. `taskshape lab finetune` fine-tunes from a local base checkpoint.
4. `taskshape lab compare` compares baseline and candidate reports.
5. `taskshape lab adopt` writes `taskshape.json` only after the candidate passes the gate.

Dataset rows contain `task`, optional `phase`, optional human `shape`, optional `role`, optional
`template`, and optional `context`. Missing labels are filled by the rule-based rubric. Held-out splits
use templates when present and otherwise a stable text hash.

Evaluation and fine-tuning disable network access inside the lab process. The base checkpoint,
dependencies and datasets must already be local.

Adoption checks that:

- the required `heldout` split is present in both reports;
- baseline and candidate reports use matching dataset hashes for compared splits;
- the selected checkpoint's weight hash matches the candidate report;
- checkpoint training metadata matches the train dataset hash in `meta.json`;
- the candidate's held-out dataset hash matches `meta.json`;
- when a checkpoint is already configured, the baseline weight hash matches that checkpoint;
- accuracy does not regress on compared splits;
- at least one compared split improves;
- calibration passes the comparison rule.

## Integrations

The repository ships three host integrations plus the MCP server.

| Integration | Intercept point | Enforce mode changes | Suggest mode | Outcome record |
| --- | --- | --- | --- | --- |
| [Claude Code plugin](../plugins/claude-code/README.md) | Function hook on `Agent` | Rewrites the Claude model alias when the selected model maps to `haiku`, `sonnet`, `opus` or `fable`; explicit models are kept by default; forks are skipped. | Logs/status only. | Accepted when the tool call did not error; seconds recorded. |
| [Copilot CLI plugin](../plugins/copilot/README.md) | `preToolUse` on `task` | Emits `permissionDecision: "allow"` with `modifiedArgs.model` and, when non-default, `modifiedArgs.reasoning_effort`; explicit models are kept by default. | Logs only. | `subagentStop` records `accepted` from `stopReason === "end_turn"`. |
| [VS Code plugin](../plugins/vscode/README.md) | `PreToolUse` on `runSubagent` | Emits `hookSpecificOutput.updatedInput.model` using VS Code model display names; named agents and explicit models are skipped by default; profiles are capped by the session model multiplier, with a 1x ceiling if the main model is unknown. | Logs only; no hook output. | `SubagentStop` records `accepted: null` because no stop reason is exposed. |
| MCP server | Local stdio tools | No host rewrite by itself; clients call `route`, `record`, `report` or `policy_table`. | Client-defined. | Client-defined through `record`. |

The Copilot CLI and VS Code plugins share the hook scripts under [plugins/shared](../plugins/shared).
They can optionally refresh a local model catalog through the Copilot CLI ACP server, cache it in
`~/.taskshape/models.json`, and filter out profiles whose models are unavailable. If discovery fails,
the hooks use the cached catalog when possible or the shipped table otherwise.

There is no Codex adapter in this repository.

## Limits

- The rubric uses fixed rules; classification quality depends on task wording.
- Shape classification is not a guarantee that a provider model will complete the task.
- Cost tiers come from the profiles file. They are policy ordering, not live pricing.
- Price-based cost estimates require catalog entries with verified input and output prices.
- Host hook behavior is specific to the current plugin implementations. VS Code routing has test
  coverage for hook payloads and outputs, but live Copilot routing inside VS Code remains
  unverified.
- The router only sees the brief and optional context supplied by the caller. Ambiguous or incomplete
  task descriptions can be classified incorrectly.
