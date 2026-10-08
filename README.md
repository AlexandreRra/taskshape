# taskshape

taskshape is a model router for agent tasks. It classifies a task and selects a model and effort setting
from a configured profile table.

The project is experimental. It includes:

- host plugins for Claude Code, GitHub Copilot CLI and VS Code agent mode;
- a dependency-free Python CLI for routing, validation and outcome reports;
- optional MCP and Laya support for local server integration and fine-tuned classifiers.

The Python router reads local catalog and profile JSON files and returns a routing decision as JSON.
It uses a rule-based classifier by default, with optional support for a local Laya checkpoint. It does
not call model-provider APIs.

## How routing works

The classifier assigns a category to a task. The routing policy uses that category and the profile table
to select a model.

For each routing request, taskshape:

1. classifies the task into one of the categories listed below;
2. selects an eligible profile using its capability, cost tier, phase and the configured budget;
3. returns the selected model, effort setting and routing reason.

Profiles are defined in JSON. Copy [catalog/profiles.example.json](catalog/profiles.example.json),
keep the models available to your installation, adjust the profile settings, and validate the file before
using it. Updating model profiles does not require changing the classifier.

## Task shapes

The classifier assigns one of these categories, called task shapes:

| Shape | Meaning |
| --- | --- |
| `lookup` | Exact lookup or extraction with no judgment. |
| `routine` | Small bounded edits, docs-only work, config changes or read-only discovery. |
| `demanding` | Single-subsystem work that needs several steps and verification. |
| `visual` | Screenshot, mockup, layout or image inspection. Requires a vision-capable profile. |
| `coupled` | Higher-risk correctness work across persistence, migrations, concurrency, security boundaries or multiple systems. |
| `review` | Independent read-only review of a bounded change. |
| `architecture` | Planning, specification, design critique or open-ended frontier reasoning. |

Each profile declares a capability level, cost tier, model, effort, phases and optional flags. The policy picks the lowest cost-tier profile whose capability covers the classified shape within the selected budget.
If no adequate profile fits the budget, it returns the strongest eligible profile within budget and includes a warning. If no eligible profile fits the budget at all, routing returns an error.

## Host plugins

The host plugins include bundled rubric/profiles, so Python is optional. They default to `enforce`; switch
to `suggest` to log decisions without rewriting launches.

### Claude Code

Requires Claude Code 2.1.289 or later.

```bash
claude plugin marketplace add AlexandreRra/taskshape
claude plugin install taskshape@taskshape
```

The Claude Code plugin routes eligible `Agent` launches with a built-in Claude profile table. Launches that already name a model are respected by default, and forks inherit the parent model. See the [Claude Code guide](plugins/claude-code/README.md).

### GitHub Copilot CLI

Requires Node 22.6 or later.

```bash
copilot plugin install AlexandreRra/taskshape:plugins/copilot
```

The Copilot CLI plugin routes eligible `task` launches and can rewrite both `model` and `reasoning_effort`. Model discovery uses the Copilot CLI's own ACP server when available; if discovery is missing or fails, routing can fall back to cached or shipped model information. See the [Copilot CLI guide](plugins/copilot/README.md).

### VS Code Agent Mode

Requires GitHub Copilot access, VS Code with agent plugin support, and Node 22.6 or later on the PATH
VS Code sees.

Add this marketplace, then install `taskshape-vscode` from the Extensions view with
`@agentPlugins taskshape`:

```json
{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": ["AlexandreRra/taskshape"]
}
```

The VS Code plugin routes eligible `runSubagent` launches and rewrites the model through VS Code's hook output. It keeps launches within VS Code's main-model cost ceiling when that ceiling is known. Hook behavior is tested against VS Code payloads; routing in a live Copilot session remains unverified. See the [VS Code guide](plugins/vscode/README.md).

## Python quick start

Use the Python package when you want explicit routing commands, MCP integration, records, reports or Laya
training. It requires Python 3.12 or later, and the core install has no runtime dependencies.

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

The command prints JSON with the chosen shape, profile, model, effort, reason, warnings and considered
profiles. Add `--log records/decisions.jsonl` to append a decision audit trail, or `--allowed` to restrict
the decision to profiles a harness is allowed to call.

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

Reports recommend the lowest cost-tier profile that meets the acceptance and sample thresholds for each
shape. Apply profile changes by editing the profiles file.

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

The server exposes `route`, `record`, `report` and `policy_table`. It runs locally and does not open a
network port. Add `--config taskshape.json --backend auto` after adopting a Laya checkpoint.

## Laya and the lab

The default CLI uses the rubric backend. To classify with
[Laya](https://huggingface.co/convaiinnovations/laya), install the optional ML dependencies and point
taskshape at an existing local checkpoint. `checkpoints/taskshape-current` is a placeholder path.

```bash
pip install -e ".[laya]"
taskshape route \
  --catalog catalog/models.json \
  --profiles catalog/profiles.example.json \
  --backend laya \
  --checkpoint checkpoints/taskshape-current \
  --task "Write the ADR for the queue redesign; weigh tradeoffs; no code"
```

The lab commands build datasets from your own labelled briefs, evaluate checkpoints, fine-tune locally, and
adopt a candidate only when the accuracy, calibration, dataset provenance and checkpoint provenance checks
pass. `checkpoints/base-laya` and `checkpoints/taskshape-candidate` are placeholder paths for local
checkpoints.

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

Brief rows are JSONL objects with `task`, optional `phase`, optional human `shape`, optional `role`, optional
`template`, and optional `context`. The lab disables network access during evaluation and fine-tuning; the
base checkpoint and dependencies must already be local. See [docs/DESIGN.md](docs/DESIGN.md) for
design details.

## Limitations

This is pre-alpha software. The shipped profile and catalog files are examples and may need updates to
match the models available through your provider plan. The rubric backend uses fixed classification rules;
it does not use a trained model. Cost estimates are available only when the catalog has verified prices
for the selected model. Provider plans and host hook behavior can change; see the plugin READMEs for
host-specific details.

## Development

Run the dependency-free test suite:

```bash
python -m unittest discover -s tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution notes.

The [CI workflow](.github/workflows/ci.yml) is configured to run the Python tests, shared-copy check and
Node hook tests on Linux, Windows and macOS. Hook tests cover installed plugin folders, encoded paths
and exclusion of task prompts and descriptions from audit fields. Routing in live Copilot sessions
requires separate validation.

License: [Apache-2.0](LICENSE).
