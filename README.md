# taskshape

taskshape routes agent subtasks to configured model profiles. It classifies a task brief, applies a local profile policy, and returns a model and effort setting that is capable enough according to your profile table.

The project is experimental. It includes:

- host plugins for Claude Code, GitHub Copilot CLI, and VS Code agent mode;
- a dependency-free Python CLI for explicit routing, validation, records, and reports;
- optional MCP and lab support for local server integration and classifier experiments;
- local Laya context selection that can inspect candidate files and return only file decisions and line ranges when available.

Routing is local. taskshape does not call model-provider APIs.

## How routing works

For each routing request, taskshape:

1. classifies the task into a shape;
2. filters profiles by phase, allowed ids, flags, and budget;
3. selects the lowest cost-tier profile whose capability covers the shape;
4. returns the selected profile, model, effort, reason, warnings, and considered profiles.

Profiles are JSON policy files. Copy [catalog/profiles.example.json](catalog/profiles.example.json), keep only the models your installation can call, adjust cost tiers and capabilities, then validate the file before using it. Updating profiles does not require changing the classifier.

## Task shapes

| Shape | Meaning |
| --- | --- |
| `lookup` | Exact lookup or extraction with no judgment. |
| `routine` | Small bounded edits, docs-only work, config changes, or read-only discovery. |
| `demanding` | Single-subsystem work that needs several steps and verification. |
| `visual` | Screenshot, mockup, layout, or image inspection. Requires a vision-capable profile. |
| `coupled` | Higher-risk correctness work across persistence, migrations, concurrency, security boundaries, or multiple systems. |
| `review` | Independent read-only review of a bounded change. |
| `architecture` | Planning, specification, design critique, or open-ended frontier reasoning. |

Each profile declares a capability level, cost tier, model, effort, phases, and optional flags. If profiles fit the budget but none is capable enough, routing returns the strongest eligible profile within budget with an `under-provisioned` warning. If no eligible profile fits the budget, routing returns an error.

## Local context selection

Use `select_context` when an agent has several candidate files and reading all of them would add unnecessary context. Taskshape reads the candidate files locally, chunks text files, asks Laya which chunks matter for the task, and returns only paths, booleans, line ranges when available, line counts, source, completeness, and warnings. It does not return raw file content.

```json
{"task":"Fix login session expiry","paths":["src/auth/session.ts","src/billing/invoices.ts"]}
```

The default behavior is plug and play: `root` defaults to the current project directory, `skip_threshold` is `0.95`, `max_file_bytes` is `262144`, `chunk_lines` is `80`, `max_chunks` is `64` across the whole request, `batch_size` is `8`, and a request accepts up to 20 paths. Advanced callers can pass those flat options when they need a different project root or bounded work budget.

The tool treats paths that escape the project root, symlinks outside the root, binary files, oversized files, incomplete coverage, unavailable files, unavailable Laya, invalid classifier answers, and runtime failures conservatively. In those cases it keeps candidates available with `source: "conservative-fallback"` or `should_read: true`; incomplete coverage recommends reading the file rather than trusting a partial negative. A file is recommended for skipping only after complete coverage and a strong negative answer.

From the Python CLI, supply an existing local Laya checkpoint:

```bash
taskshape select-context \
  --task "Fix login session expiry" \
  --path src/auth/session.ts \
  --path src/billing/invoices.ts \
  --checkpoint /path/to/local/laya
```

`--task-stdin` accepts the task on stdin; `--root`, `--skip-threshold`, `--max-file-bytes`, `--chunk-lines`, `--max-chunks`, and `--batch-size` override the defaults; `--config` can supply the checkpoint. A missing or unavailable checkpoint returns conservative file entries rather than a heuristic relevance judgment.

The MCP server exposes the same `select_context` tool and reuses its warm Laya backend across routing, context selection, and file relevance requests. The hosted plugins include a `select-context` skill that invokes their managed runtime through `runtime-cli.ts select-context`, so users do not need to install the Python MCP extra or configure a checkpoint for the plugin path. First runtime setup still downloads the pinned Node/Python/Laya assets described below.

`should_read_file` is preserved as the metadata-only API. It receives a task, path, and optional summary or excerpt supplied by the caller; it never opens the file. Prefer `select_context` when Taskshape should inspect local candidate files itself.

```bash
taskshape should-read-file \
  --task "Fix login session expiry" \
  --path src/auth/session.ts \
  --summary "Validates session tokens and expiration" \
  --checkpoint /path/to/local/laya
```

Both queries are advisory. Agents can still read files explicitly requested by the user, files named by diagnostics, or files needed to verify correctness. Installing a plugin does not intercept or block every file read, and Laya probabilities are not calibrated accuracy or measured token-savings evidence.

## Host plugins

The shipped host plugins default to `enforce` mode and the local Laya classifier. Switch to `suggest` to log decisions without rewriting launches. Set `TASKSHAPE_BACKEND=heuristic` or the plugin `backend` option to use the embedded rubric instead.

The plugin launchers reuse an existing Node 22.6+ executable when one is available. Otherwise they download pinned Node 22.23.3 into the private taskshape cache and run the hook from there; no global Node install or administrator access is required. The default Laya path then performs a first-run local runtime setup in the background: pinned `uv`, managed Python 3.12.11, pinned hash-checked CPU dependencies, and the multilingual Laya model files from a pinned Hugging Face revision. The model weights are about 650 MB, and the Python/PyTorch runtime can use several GB of disk. First setup needs network, disk space, and time. Later classification runs locally through a short-lived Python process over stdin, with offline Hugging Face/Transformers settings, no server port, and no model-provider call.

If Node or Laya setup is still running, unsupported, or fails, the plugins keep the original launch. Once the TypeScript hook can run, classifier failures are logged as skipped routing decisions. During Node bootstrap, the visible evidence may only be stderr/status text. The plugins do not fall back to the heuristic backend unless you configure that backend explicitly. Decision logs omit task prompts and descriptions.

### Claude Code

Requires Claude Code 2.1.289 or later. The plugin reuses Node 22.6+ when present or downloads pinned Node 22.23.3 into its private cache.

```bash
claude plugin marketplace add AlexandreRra/taskshape
claude plugin install taskshape@taskshape
```

The Claude Code plugin routes eligible `Agent` launches with a built-in Claude profile table. Launches that already name a model are respected by default, and forks inherit the parent model. If Laya is not ready, the launch continues unchanged and Claude shows the runtime status. See the [Claude Code guide](plugins/claude-code/README.md).

### GitHub Copilot CLI

Requires a working Copilot CLI login. The plugin reuses Node 22.6+ when present or downloads pinned Node 22.23.3 into its private cache.

```bash
copilot plugin install AlexandreRra/taskshape:plugins/copilot
```

The Copilot CLI plugin routes eligible `task` launches and can rewrite both `model` and `reasoning_effort`. Model discovery uses the Copilot CLI's ACP server when available; if discovery is missing or fails, routing can fall back to cached or shipped model information. Runtime setup status is written on session start. See the [Copilot CLI guide](plugins/copilot/README.md).

### VS Code Agent Mode

Requires GitHub Copilot access and VS Code with agent plugin support. The plugin reuses Node 22.6+ on the PATH VS Code sees or downloads pinned Node 22.23.3 into its private cache.

Add this marketplace, then install `taskshape-vscode` from the Extensions view with `@agentPlugins taskshape`:

```json
{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": ["AlexandreRra/taskshape"]
}
```

The VS Code plugin routes eligible `runSubagent` launches and rewrites the model through VS Code's hook output. It keeps launches within VS Code's main-model cost ceiling when that ceiling is known. Runtime setup status is written on session start and added to VS Code context. Hook behavior is tested against VS Code payloads; routing in a live Copilot session remains unverified. See the [VS Code guide](plugins/vscode/README.md).

## Python quick start

Use the Python package when you want explicit routing commands, MCP integration, records, reports, or lab workflows. It requires Python 3.12 or later. The core install has no runtime dependencies.

```bash
git clone https://github.com/AlexandreRra/taskshape.git
cd taskshape
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
taskshape validate --catalog catalog/models.json --profiles catalog/profiles.example.json
```

Route a task with the dependency-free rubric backend:

```bash
taskshape route \
  --catalog catalog/models.json \
  --profiles catalog/profiles.example.json \
  --budget standard \
  --backend heuristic \
  --task "Own ledger.py and tests; keep the v3 ledger format readable; the migration must be idempotent"
```

The command prints JSON with the chosen shape, profile, model, effort, reason, warnings, and considered profiles. Add `--log records/decisions.jsonl` to append a decision audit trail, or `--allowed` to restrict the decision to profiles a harness is allowed to call.

The Python CLI default is `--backend auto`: it uses the heuristic backend unless a Laya checkpoint is supplied by `--checkpoint` or config.

## Records and reports

After a routed task finishes, record the outcome:

```bash
taskshape record \
  --file records/outcomes.jsonl \
  --catalog catalog/models.json \
  --shape coupled \
  --profile sol61-high \
  --model gpt-6.1-sol \
  --effort high \
  --accepted \
  --task "Own ledger.py and tests; keep the v3 ledger format readable; the migration must be idempotent" \
  --outcome accepted \
  --input-tokens 50000 \
  --output-tokens 5000 \
  --seconds 30
```

Summarize acceptance and cost by shape/profile:

```bash
taskshape report \
  --catalog catalog/models.json \
  --profiles catalog/profiles.example.json \
  --file records/outcomes.jsonl \
  --min-samples 1
```

Reports recommend the lowest cost-tier profile that meets the acceptance and sample thresholds for each shape. Apply profile changes by editing the profiles file.

## MCP server

Install the MCP extra, then configure your MCP client to start `taskshape-mcp` over stdio:

```bash
pip install -e ".[mcp]"
taskshape-mcp \
  --profiles catalog/profiles.example.json \
  --catalog catalog/models.json \
  --records records/outcomes.jsonl \
  --decisions records/decisions.jsonl \
  --backend heuristic
```

The server exposes `route`, `select_context`, `should_read_file`, `record`, `report`, and `policy_table`. It runs locally and does not open a network port. Add `--config taskshape.json --backend auto` after adopting a Laya checkpoint. `select_context` and `should_read_file` need Laya; a heuristic-only server recommends reading conservatively. The same loaded Laya instance is reused for routing, context selection, and file relevance.

## Laya and the lab

The plugin runtime uses Laya automatically. The Python CLI uses Laya only when you install the optional ML dependencies and point taskshape at an existing local checkpoint. `checkpoints/taskshape-current` is a placeholder path.

```bash
pip install -e ".[laya]"
taskshape route \
  --catalog catalog/models.json \
  --profiles catalog/profiles.example.json \
  --backend laya \
  --checkpoint checkpoints/taskshape-current \
  --task "Write the ADR for the queue redesign; weigh tradeoffs; no code"
```

The plugin runtime currently uses the pinned public multilingual Laya base checkpoint. The classifier receives the taskshape shape definitions and context schema at inference time, but no task-specialized checkpoint has passed the adoption gate.

The repository includes a small public synthetic routing dataset under [datasets/public-routing](datasets/public-routing). It contains 160 training rows and 56 held-out rows with agent-authored English and Portuguese task descriptions. It is not real user data and is not production validation evidence. On this held-out fixture, the heuristic rubric scored 29/56 (51.79%); the pinned public multilingual Laya base scored 24/56 (42.86%), with 11/28 English rows and 13/28 Portuguese rows correct. A four-epoch head-only candidate also scored 24/56 and was rejected because it did not improve accuracy.

Lab commands build datasets from labelled briefs, evaluate checkpoints, fine-tune locally, and adopt a candidate only when the accuracy, calibration, dataset provenance, and checkpoint provenance checks pass. `checkpoints/base-laya` and `checkpoints/taskshape-candidate` are placeholder paths for local checkpoints.

```bash
taskshape lab dataset --briefs briefs.jsonl --out lab/run
taskshape lab eval --checkpoint checkpoints/base-laya --dataset lab/run/heldout.jsonl --out lab/run/base.json
taskshape lab finetune --base checkpoints/base-laya --train lab/run/train.jsonl --out checkpoints/taskshape-candidate
taskshape lab eval --checkpoint checkpoints/taskshape-candidate --dataset lab/run/heldout.jsonl --out lab/run/candidate.json
taskshape lab adopt \
  --config taskshape.json \
  --checkpoint checkpoints/taskshape-candidate \
  --baseline lab/run/base.json \
  --candidate lab/run/candidate.json \
  --meta lab/run/meta.json
```

Brief rows are JSONL objects with `task`, optional `phase`, optional human `shape`, optional `role`, optional `template`, and optional `context`. The lab disables network access during evaluation and fine-tuning; the base checkpoint and dependencies must already be local. See [docs/DESIGN.md](docs/DESIGN.md) for design details.

## Platform support and limitations

This is pre-alpha software. The shipped profile and catalog files are examples and may need updates to match the models available through your provider plan.

Fresh installation and offline Laya inference pass in [runtime CI](.github/workflows/runtime.yml) on Linux x64, Windows x64, and macOS 15 ARM64. Linux ARM64 and Windows ARM64 currently have dependency-resolution checks only. The pinned ML runtime requires macOS 14 or later on ARM64; macOS Intel is unsupported. POSIX hosts need `sh`, `tar`, `curl` or `wget`, and a SHA-256 helper such as `sha256sum`, `shasum`, or `openssl`. Windows hosts need PowerShell and `tar`.

The rubric backend uses fixed classification rules. The Laya backend uses local model files and still depends on the task wording and the training data behind the checkpoint. No task-specialized checkpoint has passed adoption yet. Shape classification is not a guarantee that a provider model will complete the task. Cost estimates are available only when the catalog has verified prices for the selected model. Provider plans and host hook behavior can change; see the plugin READMEs for host-specific details.

## Development

Run the dependency-free test suite:

```bash
python -m unittest discover -s tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution notes.

The [CI workflow](.github/workflows/ci.yml) is configured to run the Python tests, shared-copy check, and Node hook tests on Linux, Windows, and macOS. Hook tests cover installed plugin folders, encoded paths, and exclusion of task prompts and descriptions from audit fields. Routing in live Copilot sessions requires separate validation.

License: [Apache-2.0](LICENSE).
