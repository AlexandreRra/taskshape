# Design

taskshape is a local routing layer for agent harnesses. It classifies a task brief into a small shape taxonomy, then applies a profile table to choose a model/effort profile that the deployment is allowed to use.

The router does not call model providers. The Python CLI can run with the dependency-free rubric or an optional local Laya checkpoint. The shipped host plugins default to a managed local Laya runtime and keep the original launch if that runtime is not ready.

## Routing flow

A routing request follows the same policy path across the CLI, MCP server, and host plugins:

1. A host hook, MCP client, or CLI command sends a task brief to taskshape.
2. The classifier returns one shape and, when available, a probability distribution over the offered shapes.
3. The policy filters profiles by phase, required flags, allowed profile ids, and budget.
4. The policy chooses the lowest cost-tier profile whose capability covers the shape.
5. The caller receives or applies the selected model and effort, plus reason, warnings, and considered profiles.

The main entrypoints are:

- [src/taskshape/cli.py](../src/taskshape/cli.py): `route`, `validate`, `record`, `report`, and `lab`.
- [src/taskshape/router.py](../src/taskshape/router.py): classifier selection and route result shape.
- [src/taskshape/policy.py](../src/taskshape/policy.py): profile filtering and selection.
- [src/taskshape/mcp_server.py](../src/taskshape/mcp_server.py): local stdio MCP tools.
- [plugins/shared](../plugins/shared): shared Copilot CLI and VS Code hook implementation.
- [plugins/claude-code/hooks/register.ts](../plugins/claude-code/hooks/register.ts): Claude Code function hook.

## Shape taxonomy

Shapes are separate from provider model names. A deployment can update model ids, effort levels, prices, or authorization without retraining a classifier.

| Shape | Capability | Meaning |
| --- | ---: | --- |
| `lookup` | 0 | Exact lookup, extraction, or classification with no judgment. |
| `routine` | 1 | Small bounded edits, docs-only work, config changes, or read-only discovery. |
| `demanding` | 2 | Single-subsystem work that needs several steps and verification. |
| `visual` | 2 | Screenshot, mockup, layout, or image inspection; requires `vision: true`. |
| `coupled` | 3 | Persistence, migrations, concurrency, security boundaries, multiple systems, or root-cause work. |
| `review` | 3 | Independent read-only review of a bounded change. |
| `architecture` | 4 | Planning, specification, critique, design disputes, or broad reasoning. |

The source of truth is [src/taskshape/shapes.py](../src/taskshape/shapes.py). Work-phase routing can return every shape except `review`; review-phase routing returns only `review` or `architecture`.

## Classifiers and runtime surfaces

The Python CLI default is `--backend auto`. In the CLI and MCP server, auto uses the heuristic backend unless `--checkpoint` or config supplies a Laya checkpoint. The heuristic backend uses [src/taskshape/rubric.py](../src/taskshape/rubric.py), returns soft probabilities, and requires no runtime dependencies.

The Python `laya` backend loads a local checkpoint directory containing `rl_agent_config.json`. It sets Hugging Face and Transformers offline environment variables before importing Laya, so route-time classification is local. If a backend prediction fails or returns an invalid distribution after the backend was created, the Python router falls back to the heuristic backend and records a warning. Backend setup errors, invalid policy inputs, unknown budgets, unknown `--allowed` profile ids, and missing eligible profiles still return errors.

The host plugins use a different default path. Their default `backend` is `laya`, backed by the managed runtime in [plugins/shared/runtime.ts](../plugins/shared/runtime.ts) and [runtime](../runtime). The managed runtime currently uses the pinned public multilingual Laya base checkpoint. It supplies taskshape shape definitions and the expected context schema in the classification question; it is not a task-specialized fine-tuned checkpoint. Set `TASKSHAPE_BACKEND=heuristic` or plugin config `backend: "heuristic"` to use the embedded rubric. Set `command` only when you want an external Python `taskshape route` command instead of the built-in plugin runtime.

## Managed plugin runtime

On first use, the plugin runtime prepares local assets in the taskshape home directory:

- an existing Node 22.6+ executable, or pinned Node 22.23.3 downloaded into the private cache from [runtime/node-assets.tsv](../runtime/node-assets.tsv);
- pinned `uv` 0.12.23 from [runtime/assets.json](../runtime/assets.json);
- managed Python 3.12.11;
- pinned hash-checked dependencies from [runtime/requirements.lock](../runtime/requirements.lock);
- the multilingual Laya model files from a pinned Hugging Face revision.

The large model file is about 650 MB. PyTorch and the managed Python environment can bring total disk use to several GB. First setup needs network and disk space and may still be running when the first routed launch occurs. `SessionStart` reports setup state on stderr for Copilot CLI and VS Code; VS Code also receives the status as `additionalContext`. Claude Code reports runtime failures through the function hook status and toast path.

After setup, classification is local. The plugins start a short-lived Python process, pass the task and phase over stdin, run with offline Hugging Face and Transformers settings, and read JSON from stdout. They do not open a server port, call model providers, or write task prompts/descriptions to decision audit fields.

If Node or Laya setup is unsupported, installing, or fails at classification time, plugin routing is skipped and the original host launch is kept. Once the TypeScript hook can run, classifier failures are logged as skipped decisions. During Node bootstrap, there may be only stderr/status output. The plugin does not fall back to the heuristic backend unless the user explicitly configured the heuristic backend.

## Profile policy

A profiles file contains:

- `profiles`: authorized model/effort profiles with `id`, `model`, `effort`, `capability`, `cost_tier`, allowed `phases`, and optional flags such as `vision`;
- `budgets`: named maximum cost tiers such as `economy`, `standard`, and `default`.

For a classified shape, [src/taskshape/policy.py](../src/taskshape/policy.py):

1. keeps only profiles for the current phase;
2. limits selection to explicitly allowed profile ids, if supplied;
3. removes profiles missing required flags such as `vision`;
4. keeps only profiles with `cost_tier <= max_cost_tier`;
5. chooses the lowest cost-tier profile whose capability covers the shape.

If profiles are eligible and within budget but none is capable enough, the policy chooses the most capable profile within budget and adds an `under-provisioned` warning. If no profile is eligible or no eligible profile fits the budget, routing fails instead of inventing a choice.

See [catalog/profiles.example.json](../catalog/profiles.example.json) for the schema in use and [catalog/models.json](../catalog/models.json) for optional model notes and list-price data.

## Records and reports

Routing decisions and execution outcomes are separate. Both are handled by [src/taskshape/records.py](../src/taskshape/records.py).

- `taskshape route --log decisions.jsonl` appends a decision audit row.
- `taskshape record --file outcomes.jsonl ...` appends the result of a task after it ran.
- `taskshape report --file outcomes.jsonl ...` aggregates acceptance, mean cost, and mean seconds by shape/profile.

Report suggestions are advisory. A report names the lowest cost-tier profile that meets the acceptance and sample thresholds for each shape. It does not edit profile files.

The shared plugin hooks record decisions and outcomes under `~/.taskshape` by default. Decision rows omit raw task and description text and store metadata such as shape, profile, model, effort, backend, session id, and unavailable profiles. Older logs from earlier plugin versions may contain different fields.

## Lab workflow

The lab commands are for local classifier experiments. They are not required for the default plugin runtime.

1. `taskshape lab dataset` normalizes labelled task briefs into train and held-out splits.
2. `taskshape lab eval` evaluates a checkpoint and writes metrics, calibration, dataset hashes, and checkpoint hashes.
3. `taskshape lab finetune` fine-tunes from a local base checkpoint.
4. `taskshape lab compare` compares baseline and candidate reports.
5. `taskshape lab adopt` writes `taskshape.json` only after the candidate passes the gate.

Dataset rows contain `task`, optional `phase`, optional human `shape`, optional `role`, optional `template`, and optional `context`. Missing labels are filled by the rule-based rubric. Held-out splits use templates when present and otherwise a stable task-text hash.

Evaluation and fine-tuning disable network access inside the lab process. The base checkpoint, dependencies, and datasets must already be local.

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

The public synthetic dataset in [datasets/public-routing](../datasets/public-routing) contains 160 training rows and 56 held-out agent-authored English and Portuguese examples. It is not real user data and is not external validation evidence. On this held-out fixture, the heuristic rubric scored 29/56 (51.79%), the pinned public multilingual Laya base scored 24/56 (42.86%), and a four-epoch head-only candidate also scored 24/56. The candidate did not pass adoption because it did not improve accuracy.

## Integrations

The repository ships three host integrations plus the MCP server.

| Integration | Intercept point | Default classifier | Enforce mode changes | Runtime failure behavior | Outcome record |
| --- | --- | --- | --- | --- | --- |
| [Claude Code plugin](../plugins/claude-code/README.md) | Function hook on `Agent` | Managed local Laya runtime; explicit heuristic option. | Rewrites the Claude model alias when the selected model maps to `haiku`, `sonnet`, `opus`, or `fable`; explicit models are kept by default; forks are skipped. | Keeps the original launch and reports status/toast. | Accepted when the tool call did not error; seconds recorded. |
| [Copilot CLI plugin](../plugins/copilot/README.md) | `preToolUse` on `task` | Managed local Laya runtime; explicit heuristic option. | Emits `permissionDecision: "allow"` with `modifiedArgs.model` and, when non-default, `modifiedArgs.reasoning_effort`; explicit models are kept by default. | Keeps the original launch and records a skipped decision. | `subagentStop` records `accepted` from `stopReason === "end_turn"`. |
| [VS Code plugin](../plugins/vscode/README.md) | `PreToolUse` on `runSubagent` | Managed local Laya runtime; explicit heuristic option. | Emits `hookSpecificOutput.updatedInput.model` using VS Code model display names; named agents and explicit models are skipped by default; profiles are capped by the session model multiplier, with a 1x ceiling if the main model is unknown. | Keeps the original launch and records a skipped decision. | `SubagentStop` records `accepted: null` because no stop reason is exposed. |
| MCP server | Local stdio tools | Python `--backend auto`; heuristic unless checkpoint/config is supplied. | No host rewrite by itself; clients call `route`, `record`, `report`, or `policy_table`. | Client-defined. | Client-defined through `record`. |

The Copilot CLI and VS Code plugins share hook scripts under [plugins/shared](../plugins/shared). They can optionally refresh a local model catalog through the Copilot CLI ACP server, cache it in `~/.taskshape/models.json`, and filter out profiles whose models are unavailable. If discovery fails, the hooks use the cached catalog when possible or the shipped table otherwise.

There is no Codex adapter in this repository.

## Platform support

The managed plugin runtime has dry-run coverage for Linux x64, Linux ARM64, Windows x64, Windows ARM64, and macOS 14 or later on ARM64. macOS Intel is unsupported by the pinned ML runtime. Alpine/Linux musl is unsupported. POSIX launchers require `sh`, `tar`, a downloader (`curl` or `wget`), and a SHA-256 helper (`sha256sum`, `shasum`, or `openssl`). Windows launchers require PowerShell and `tar`. Full runtime CI across the supported operating systems is still pending.

## Limits

- The heuristic rubric uses fixed rules; classification quality depends on task wording.
- The Laya backend is local, but its quality depends on the checkpoint and training data. No task-specialized checkpoint has passed adoption yet.
- Shape classification is not a guarantee that a provider model will complete the task.
- Cost tiers come from the profiles file. They are policy ordering, not live pricing.
- Price-based cost estimates require catalog entries with verified input and output prices.
- Host hook behavior is specific to the current plugin implementations. VS Code routing has test coverage for hook payloads and outputs, but live Copilot routing inside VS Code remains unverified.
- The router only sees the brief and optional context supplied by the caller. Ambiguous or incomplete task descriptions can be classified incorrectly.
