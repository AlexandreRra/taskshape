# Contributing

taskshape is pre-alpha. Keep changes small, documented, and easy to verify.

## Development setup

Use Python 3.12 or later for the Python package:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
```

The core `taskshape.*` package uses the Python standard library except behind optional extras. `lab.py` and `router.LayaBackend` import ML dependencies lazily through the `laya` extra. The MCP server is behind the `mcp` extra.

The host plugins reuse Node 22.6+ when it is available and otherwise download pinned Node 22.23.3 into the taskshape cache. The default plugin backend also downloads a managed Python 3.12.11 runtime for classification; contributors do not need system Node or system Python for plugin use, but tests still use the repository Python and Node environments.

## Tests

Run the dependency-free Python suite:

```bash
python3 -m unittest discover -s tests
```

Run shared plugin tests when changing hooks or plugin docs:

```bash
node --experimental-strip-types --test plugins/shared/harness.test.ts plugins/shared/runtime.test.ts
node --experimental-strip-types --test plugins/copilot/hooks/harness.test.ts
node --experimental-strip-types --test plugins/vscode/hooks/harness.test.ts
```

Check copied hook files after editing [plugins/shared](plugins/shared):

```bash
python3 scripts/sync-shared.py --check
```

## Documentation

Document the behavior that exists in code. Test command examples before adding them, or state the validation gap. Keep README and plugin README examples aligned with actual options, defaults, and host behavior.

Use relative links for repository files. Keep public docs focused on current repository behavior.

## Catalogs and profiles

Catalog edits in [catalog/models.json](catalog/models.json) must include a source URL and `as_of` date when they contain price data. Prices are used for estimates only. Cost tiers in profile files are policy ordering values, not live provider pricing.

Profile edits should preserve the schema used by [catalog/profiles.example.json](catalog/profiles.example.json). Validate changed profiles before documenting them:

```bash
taskshape validate --catalog catalog/models.json --profiles catalog/profiles.example.json
```

## Managed plugin runtime

The default plugin backend uses the managed runtime described by [runtime/assets.json](runtime/assets.json) and [runtime/requirements.lock](runtime/requirements.lock). When changing it:

- keep dependency hashes pinned;
- keep Node download pins in [runtime/node-assets.tsv](runtime/node-assets.tsv) current when changing launcher support;
- keep `uv pip sync --require-hashes --only-binary :all:` compatible with the lock;
- update platform support notes when asset support changes;
- do not commit downloaded Node installs, virtual environments, managed Python installs, model weights, or runtime caches;
- keep first-run setup failure behavior non-blocking for host launches.

The runtime downloads pinned assets on first use and runs later classification locally through stdin/stdout. Do not add provider calls or prompt logging to plugin routing.

## Lab and datasets

A checkpoint is adopted only through `taskshape lab adopt` with matching evaluation reports and provenance checks. Do not commit trained weights.

The public dataset under [datasets/public-routing](datasets/public-routing) is synthetic and agent-authored. Treat it as a small classifier-development fixture, not as production validation or user-derived data.

## Pull requests

Include the behavior change, tests run, and known validation gaps. For documentation changes, list examples or commands you verified. For plugin changes, include the relevant host limitation if live host behavior was not exercised.
