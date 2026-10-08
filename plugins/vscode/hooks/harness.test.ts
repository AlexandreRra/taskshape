// Run: node --experimental-strip-types --test plugins/copilot/hooks/harness.test.ts   (or plugins/vscode/hooks/harness.test.ts)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  CATALOG_RETRY, CATALOG_TTL, DEFAULT_CONFIG, type Decide, applyCatalog, catalogFresh, detectHarness, ensureConfig, loadProfilesFrom,
  localCandidates, multiplierCeiling, outcomeFor, parseAcpModels, parseConfig, popPending, routeClassified, routeEmbedded, vscodeModelName, writeJson,
} from './harness.ts'
import { discoverModels } from './discover.ts'

const here = dirname(fileURLToPath(import.meta.url))
const profilesPath = [join(here, '..', 'profiles.copilot.json'), join(here, 'profiles.copilot.json')].find(p => existsSync(p)) as string
const nodeAssetsPath = [join(here, '..', 'runtime', 'node-assets.tsv'), join(here, '..', '..', 'runtime', 'node-assets.tsv')].find(p => existsSync(p)) as string
const table = loadProfilesFrom(readFileSync(profilesPath, 'utf8'))
const decide: Decide = (prompt, candidates) => routeEmbedded(prompt, 'work', table, 'default', candidates)
const layaDecide: Decide = (prompt, candidates) => routeClassified(prompt, 'work', table, 'default', 'coupled', 0.91, 'laya', candidates, { coupled: 0.91 })
const enforce = { ...DEFAULT_CONFIG, mode: 'enforce' as const }
const suggest = { ...DEFAULT_CONFIG, mode: 'suggest' as const }
const task = (prompt: string, extra: Record<string, unknown> = {}) => ({
  sessionId: 's1', toolName: 'task', toolArgs: { name: 'n', agent_type: 'general-purpose', description: 'd', prompt, ...extra },
})
const sub = (prompt: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'v1', hook_event_name: 'PreToolUse', tool_name: 'runSubagent', tool_use_id: 't1', tool_input: { prompt, description: 'd', ...extra },
})
const COUPLED = 'Own ledger.py and tests; the migration must be idempotent'
const VISUAL = 'Review the screenshot against the mockup and list visual defects'
const TYPO = 'Fix the typo in README and bump the version'
const SECRET_PROMPT = 'SENSITIVE_PROMPT_do_not_log_7fd45e98 owns payments.ts and tests; migration must be idempotent'
const SECRET_DESCRIPTION = 'SENSITIVE_DESCRIPTION_do_not_log_d4c5b6a7'
const POSIX = process.platform !== 'win32'
const platformKey = (): string => {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64'
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win-arm64'
  if (process.platform === 'win32' && process.arch === 'ia32') return 'win-x86'
  return 'unsupported'
}

// The ACP `session/new` model list exactly as Copilot CLI 1.0.92 shapes it (auto twice, usage as "0.33x", enablement).
const ACP_MODELS = [
  { modelId: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' },
  { modelId: 'auto', name: 'Auto', description: 'Auto', _meta: { copilotUsage: '1x', copilotEnablement: 'enabled' } },
  { modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', _meta: { copilotUsage: '1x', copilotEnablement: 'enabled', copilotPriceCategory: 'medium' } },
  { modelId: 'gpt-5-mini', name: 'GPT-5 mini', _meta: { copilotUsage: '0x', copilotEnablement: 'enabled', copilotPriceCategory: 'low' } },
  { modelId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', _meta: { copilotUsage: '0.33x', copilotEnablement: 'enabled' } },
  { modelId: 'gpt-6-luna', name: 'GPT-6 Luna', _meta: { copilotUsage: '1x', copilotEnablement: 'disabled' } },
]
const acpResult = (models: unknown[]) => ({ sessionId: 'fake', models: { availableModels: models, currentModelId: 'auto' }, modes: {} })

/** A stand-in `copilot` executable speaking just enough ACP for discovery; 'hang' never answers. */
const fakeCopilot = (dir: string, models: unknown[] | 'hang'): string => {
  mkdirSync(dir, { recursive: true })
  const server = join(dir, 'fake-acp.mjs')
  writeFileSync(server, models === 'hang'
    ? 'setInterval(() => {}, 1000)\n'
    : "let buf = ''\n"
      + "process.stdin.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line) } catch { continue }\n"
      + "  if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\\n')\n"
      + `  if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: ${JSON.stringify(acpResult(models))} }) + '\\n') } })\n`
      + "process.stdin.on('end', () => process.exit(0))\n")
  const bin = join(dir, 'copilot')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`, { mode: 0o755 })
  return bin
}

test('config: file values, env overrides, safe defaults', () => {
  assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG)
  const fromFile = parseConfig({ mode: 'enforce', budget: 'economy', backend: 'heuristic', respectExplicitModel: false, routeNamedAgents: true })
  assert.equal(fromFile.mode, 'enforce')
  assert.equal(fromFile.budget, 'economy')
  assert.equal(fromFile.backend, 'heuristic')
  assert.equal(fromFile.respectExplicitModel, false)
  assert.equal(fromFile.routeNamedAgents, true)
  const fromEnv = parseConfig({ mode: 'enforce', backend: 'laya' }, { TASKSHAPE_MODE: 'suggest', TASKSHAPE_BUDGET: 'standard', TASKSHAPE_BACKEND: 'heuristic', TASKSHAPE_COMMAND: '/opt/taskshape', TASKSHAPE_ROUTE_NAMED_AGENTS: 'true' })
  assert.equal(fromEnv.mode, 'suggest')
  assert.equal(fromEnv.budget, 'standard')
  assert.equal(fromEnv.backend, 'heuristic')
  assert.equal(fromEnv.command, '/opt/taskshape')
  assert.equal(fromEnv.routeNamedAgents, true)
  assert.equal(parseConfig({ mode: 'bogus' }).mode, 'enforce', 'an unknown mode falls back to the default')
  assert.equal(parseConfig({ backend: 'bogus' }).backend, 'laya', 'an unknown backend falls back to the default')
  assert.equal(DEFAULT_CONFIG.mode, 'enforce', 'installing is the whole setup: routing is on by default')
  assert.equal(DEFAULT_CONFIG.backend, 'laya', 'Laya is the default router backend')
})

test('first run writes a ready-to-edit config file and never overwrites it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskshape-config-'))
  try {
    const path = join(dir, 'nested', 'copilot.json')
    assert.equal(ensureConfig(path), true)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(typeof written.note, 'string')
    assert.deepEqual(parseConfig(written), DEFAULT_CONFIG, 'the template must hold every default, so editing one value is the whole setup')
    for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(key in written, `${key} must be listed in the template`)
    writeFileSync(path, '{ "mode": "enforce" }')
    assert.equal(ensureConfig(path), false)
    assert.equal(parseConfig(JSON.parse(readFileSync(path, 'utf8'))).mode, 'enforce', 'an existing file is left alone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('model catalog: the ACP list is parsed, trusted for a day, and narrows the table to what the account offers', () => {
  const models = parseAcpModels(acpResult(ACP_MODELS))
  assert.deepEqual(Object.keys(models).sort(), ['auto', 'claude-haiku-4.5', 'claude-sonnet-5.5', 'gpt-5-mini'], 'disabled models are left out')
  assert.deepEqual(models['claude-haiku-4.5'], { name: 'Claude Haiku 4.5', multiplier: 0.33 })
  assert.deepEqual(models['gpt-5-mini'], { name: 'GPT-5 mini', multiplier: 0 })
  assert.deepEqual(models.auto, { name: 'Auto' }, 'Auto keeps no multiplier: VS Code applies no ceiling under it')
  assert.deepEqual(parseAcpModels({}), {})
  assert.deepEqual(parseAcpModels({ models: { availableModels: [{ name: 'no id' }, { modelId: '' }] } }), {})

  const now = 1_800_000_000
  assert.equal(catalogFresh(undefined, now), false)
  assert.equal(catalogFresh({ ts: now - CATALOG_TTL + 60, source: 'copilot-acp', models }, now), true)
  assert.equal(catalogFresh({ ts: now - CATALOG_TTL - 1, source: 'copilot-acp', models }, now), false)
  assert.equal(catalogFresh({ ts: now - CATALOG_RETRY - 1, source: 'copilot-acp', models, error: 'x' }, now), false, 'a failed refresh is retried sooner')
  assert.equal(catalogFresh({ ts: now - 10, source: 'copilot-acp', models: {}, error: 'x' }, now), true)

  const applied = applyCatalog(table, { ts: now, source: 'copilot-acp', models })
  assert.deepEqual(applied.table.profiles.map(p => p.id), ['gpt-5-mini', 'haiku', 'sonnet'])
  assert.deepEqual(applied.dropped, ['gpt-6-luna', 'mai-code-flash', 'gemini-flash', 'grok', 'gpt-5.4', 'codex', 'kimi'])
  assert.equal(applied.table.models['claude-haiku-4.5'].multiplier, 0.33, 'discovered multipliers win')
  assert.equal(applied.table.models['gpt-5.4'].name, 'GPT-5.4', 'shipped entries stay as a fallback')
  assert.equal(applied.warning, undefined)
  // routing then stays within the account's models
  const routed = routeEmbedded(TYPO, 'work', applied.table, 'default')
  assert.equal(routed.model, 'claude-haiku-4.5')
  assert.equal(routeEmbedded(COUPLED, 'work', applied.table, 'default').model, 'claude-sonnet-5.5')
  // and VS Code's ceiling uses the discovered multipliers
  assert.deepEqual(localCandidates(applied.table, multiplierCeiling(applied.table, 'gpt-5-mini')).map(p => p.id), ['gpt-5-mini'])
  // empty or useless catalogs leave the table alone
  assert.deepEqual(applyCatalog(table, undefined).table, table)
  assert.deepEqual(applyCatalog(table, { ts: now, source: 'copilot-acp', models: {} }).table, table)
  const useless = applyCatalog(table, { ts: now, source: 'copilot-acp', models: { 'something-else': { name: 'X', multiplier: 1 } } })
  assert.deepEqual(useless.table.profiles, table.profiles)
  assert.match(useless.warning ?? '', /no profile names a model/)
})

test('discoverModels: reads the ACP model list and gives up on a silent or missing CLI', { skip: !POSIX }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskshape-acp-'))
  try {
    const good = fakeCopilot(join(dir, 'good'), ACP_MODELS)
    const found = await discoverModels({ command: good, cwd: dir, timeoutMs: 5000 })
    assert.equal(found.error, undefined)
    assert.equal(found.source, 'copilot-acp')
    assert.equal(found.models['claude-haiku-4.5']?.multiplier, 0.33)
    assert.equal(found.models.auto?.multiplier, undefined)
    const hang = fakeCopilot(join(dir, 'hang'), 'hang')
    const started = Date.now()
    const silent = await discoverModels({ command: hang, cwd: dir, timeoutMs: 800 })
    assert.deepEqual(silent.models, {})
    assert.match(silent.error ?? '', /did not answer/)
    assert.ok(Date.now() - started < 3000)
    const missing = await discoverModels({ command: join(dir, 'nope'), cwd: dir, timeoutMs: 800 })
    assert.deepEqual(missing.models, {})
    assert.match(missing.error ?? '', /nope/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('harness detection from the payload shape', () => {
  assert.equal(detectHarness(task('x')), 'copilot-cli')
  assert.equal(detectHarness(sub('x')), 'vscode-local')
  assert.equal(detectHarness({ prompt: 'x' }), 'unknown')
  assert.equal(detectHarness(null), 'unknown')
})

test('shipped profiles carry a VS Code name and multiplier for every model', () => {
  for (const p of table.profiles) {
    assert.ok(table.models[p.model]?.name, `${p.id} lacks a VS Code name`)
    assert.equal(typeof table.models[p.model]?.multiplier, 'number', `${p.id} lacks a multiplier`)
  }
  assert.equal(vscodeModelName(table, 'gpt-5.4'), 'GPT-5.4 (copilot)')
  assert.equal(vscodeModelName(table, 'nope'), undefined)
  assert.equal(table.models['gemini-3.8-flash'].multiplier, 14)
})

test('shipped Copilot profiles route each shape to the cheapest adequate model (CLI)', () => {
  const pick = (prompt: string, budget = 'default') => routeEmbedded(prompt, 'work', table, budget)
  assert.equal(pick('Fix the typo in README and bump the version').model, 'gpt-6-luna')
  assert.equal(pick('Implement the export feature; cause not yet confirmed; reproduce first, several steps').model, 'gemini-3.8-flash')
  assert.equal(pick(VISUAL).model, 'gemini-3.8-flash')
  const coupled = pick(COUPLED)
  assert.equal(coupled.shape, 'coupled')
  assert.ok(['claude-sonnet-5.5', 'gpt-5.4'].includes(coupled.model))
  assert.equal(coupled.effort, 'high')
  const arch = pick('Write the ADR for the queue redesign; weigh tradeoffs; no code')
  assert.equal(arch.shape, 'architecture')
  assert.ok(arch.warnings.some(w => w.includes('under-provisioned')))
  assert.equal(pick(COUPLED, 'economy').model, 'gemini-3.8-flash')
})

test('Copilot CLI: suggest reports, enforce rewrites model and reasoning_effort, skips are explicit', () => {
  const suggested = outcomeFor(task(COUPLED), suggest, decide, table)
  assert.equal(suggested.kind, 'suggest')
  const enforced = outcomeFor(task(COUPLED), enforce, decide, table)
  assert.equal(enforced.kind, 'enforce')
  if (enforced.kind === 'enforce' && 'modifiedArgs' in enforced.output) {
    assert.equal(enforced.output.permissionDecision, 'allow')
    assert.ok(['claude-sonnet-5.5', 'gpt-5.4'].includes(enforced.output.modifiedArgs.model as string))
    assert.equal(enforced.output.modifiedArgs.reasoning_effort, 'high')
    assert.equal(enforced.output.modifiedArgs.prompt, COUPLED)
    assert.equal(enforced.output.modifiedArgs.agent_type, 'general-purpose')
  } else assert.fail('expected a modifiedArgs output')
  const low = outcomeFor(task('Fix the typo in README'), enforce, decide, table)
  if (low.kind === 'enforce' && 'modifiedArgs' in low.output) assert.equal(low.output.modifiedArgs.reasoning_effort, 'low')
  assert.equal(outcomeFor({ toolName: 'bash', toolArgs: { prompt: 'x' } }, enforce, decide, table).kind, 'skip')
  assert.equal(outcomeFor(task(''), enforce, decide, table).kind, 'skip')
  assert.equal(outcomeFor(task('x', { model: 'gpt-5.4' }), enforce, decide, table).kind, 'skip')
  assert.equal(outcomeFor(task('x', { model: 'auto' }), enforce, decide, table).kind, 'enforce')
  assert.equal(outcomeFor(task('x', { model: 'gpt-5.4' }), { ...enforce, respectExplicitModel: false }, decide, table).kind, 'enforce')
})

test('VS Code: enforce answers with hookSpecificOutput.updatedInput and the display name', () => {
  const out = outcomeFor(sub('Fix the typo in README and bump the version'), enforce, decide, table)
  assert.equal(out.kind, 'enforce')
  if (out.kind === 'enforce' && 'hookSpecificOutput' in out.output) {
    const h = out.output.hookSpecificOutput
    assert.equal(h.hookEventName, 'PreToolUse')
    assert.equal(h.permissionDecision, 'allow')
    assert.equal(h.updatedInput.model, 'GPT-6 Luna (copilot)')
    assert.equal(h.updatedInput.prompt, 'Fix the typo in README and bump the version')
    assert.equal(h.updatedInput.description, 'd')
    assert.ok(!('reasoning_effort' in h.updatedInput))
    assert.equal(out.decision.model, 'gpt-6-luna')
    assert.equal(out.decision.model_name, 'GPT-6 Luna (copilot)')
  } else assert.fail('expected a hookSpecificOutput answer')
  const suggested = outcomeFor(sub(COUPLED), suggest, decide, table)
  assert.equal(suggested.kind, 'suggest')
  if (suggested.kind === 'suggest') assert.ok(suggested.decision.model_name?.endsWith(' (copilot)'))
})

test('Laya classifications route through the shared policy without heuristic recomputation', () => {
  const out = outcomeFor(task('Fix only a typo'), enforce, layaDecide, table)
  assert.equal(out.kind, 'enforce')
  if (out.kind !== 'enforce' || !('modifiedArgs' in out.output)) assert.fail('expected a CLI rewrite')
  assert.equal(out.decision.source, 'laya')
  assert.equal(out.decision.shape, 'coupled')
  assert.equal(out.decision.shape_probabilities?.coupled, 0.91)
  assert.ok(['claude-sonnet-5.5', 'gpt-5.4'].includes(out.output.modifiedArgs.model as string))
  assert.equal(out.output.modifiedArgs.reasoning_effort, 'high')
})

test('persistent audit files omit raw prompt and description for both harnesses and modes', () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const cases = [
      { label: 'copilot-enforce', session: 'c-enforce', mode: 'enforce', payload: task(`${SECRET_PROMPT} copilot enforce`, { description: `${SECRET_DESCRIPTION} copilot enforce` }) },
      { label: 'copilot-suggest', session: 'c-suggest', mode: 'suggest', payload: task(`${SECRET_PROMPT} copilot suggest`, { description: `${SECRET_DESCRIPTION} copilot suggest` }) },
      { label: 'vscode-enforce', session: 'v-enforce', mode: 'enforce', payload: sub(`${SECRET_PROMPT} vscode enforce`, { description: `${SECRET_DESCRIPTION} vscode enforce` }) },
      { label: 'vscode-suggest', session: 'v-suggest', mode: 'suggest', payload: sub(`${SECRET_PROMPT} vscode suggest`, { description: `${SECRET_DESCRIPTION} vscode suggest` }) },
    ] as const
    for (const item of cases) {
      const payload = JSON.parse(JSON.stringify(item.payload))
      if ('sessionId' in payload) payload.sessionId = item.session
      else payload.session_id = item.session
      const ran = runHook('pretooluse.ts', payload, home, { TASKSHAPE_MODE: item.mode })
      assert.equal(ran.status, 0, `${item.label}: ${ran.stderr}`)
      if (item.mode === 'enforce') {
        const output = JSON.parse(ran.stdout)
        const forwarded = 'modifiedArgs' in output ? output.modifiedArgs : output.hookSpecificOutput.updatedInput
        assert.equal(forwarded.prompt, 'toolArgs' in payload ? payload.toolArgs.prompt : payload.tool_input.prompt)
        assert.equal(forwarded.description, 'toolArgs' in payload ? payload.toolArgs.description : payload.tool_input.description)
      } else {
        assert.equal(ran.stdout, '', `${item.label}: suggest mode must be quiet`)
      }
      const pending = readFileSync(join(home, 'pending', `${item.session}.json`), 'utf8')
      assert.ok(pending.length > 0, `${item.label}: pending row must be written before outcome`)
      assert.equal(pending.includes(SECRET_PROMPT), false)
      assert.equal(pending.includes(SECRET_DESCRIPTION), false)
      assert.equal(pending.includes('"description"'), false)
      const stopPayload = 'sessionId' in payload
        ? { sessionId: item.session, agentType: 'general-purpose', stopReason: 'end_turn', response: 'done' }
        : { session_id: item.session, agent_id: 'a1', agent_type: 'default', stop_hook_active: false }
      const stopped = runHook('subagentstop.ts', stopPayload, home)
      assert.equal(stopped.status, 0, `${item.label}: ${stopped.stderr}`)
    }
    const decisions = readFileSync(join(home, 'decisions.jsonl'), 'utf8')
    const outcomes = readFileSync(join(home, 'outcomes.jsonl'), 'utf8')
    assert.ok(decisions.length > 0)
    assert.ok(outcomes.length > 0)
    assert.equal(decisions.trim().split('\n').length, 4)
    assert.equal(outcomes.trim().split('\n').length, 4)
    assert.deepEqual(JSON.parse(decisions.trim().split('\n')[0]).mode, 'enforced')
    assert.deepEqual(JSON.parse(decisions.trim().split('\n')[1]).mode, 'suggested')
    assert.ok(existsSync(join(home, 'pending')), 'pending directory must be created')
    const persisted = allPersistedText(home)
    assert.ok(persisted.length > 0)
    assert.equal(persisted.includes(SECRET_PROMPT), false)
    assert.equal(persisted.includes(SECRET_DESCRIPTION), false)
    assert.equal(persisted.includes('"description"'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('VS Code: explicit models and named agents are left alone unless configured otherwise', () => {
  assert.equal(outcomeFor(sub('x', { model: 'Claude Sonnet 5.5 (copilot)' }), enforce, decide, table).kind, 'skip')
  assert.equal(outcomeFor(sub('x', { model: 'Claude Sonnet 5.5 (copilot)' }), { ...enforce, respectExplicitModel: false }, decide, table).kind, 'enforce')
  const named = outcomeFor(sub('x', { agentName: 'reviewer' }), enforce, decide, table)
  assert.equal(named.kind, 'skip')
  if (named.kind === 'skip') assert.match(named.why, /named agent reviewer/)
  const routed = outcomeFor(sub('x', { agentName: 'reviewer' }), { ...enforce, routeNamedAgents: true }, decide, table)
  assert.equal(routed.kind, 'enforce')
  if (routed.kind === 'enforce' && 'hookSpecificOutput' in routed.output) assert.equal(routed.output.hookSpecificOutput.updatedInput.agentName, 'reviewer')
  assert.equal(outcomeFor({ tool_name: 'read_file', tool_input: { prompt: 'x' } }, enforce, decide, table).kind, 'skip')
  assert.equal(outcomeFor(sub(''), enforce, decide, table).kind, 'skip')
})

test("VS Code: the main model's multiplier caps which profiles may be launched", () => {
  assert.equal(multiplierCeiling(table, undefined), 1)
  assert.equal(multiplierCeiling(table, 'unknown-model'), 1)
  assert.equal(multiplierCeiling(table, 'auto'), Number.POSITIVE_INFINITY)
  assert.equal(multiplierCeiling(table, 'gpt-5-mini'), 0)
  assert.equal(multiplierCeiling(table, 'copilot/gpt-5.4'), 1)
  assert.ok(!localCandidates(table, 1).some(p => p.id === 'gemini-flash'), 'a 14x model is out under a 1x ceiling')
  assert.ok(localCandidates(table, 1).some(p => p.id === 'haiku'), '0.33x stays in under 1x')
  assert.deepEqual(localCandidates(table, 0).map(p => p.id), ['gpt-5-mini'])
  const unknownMain = outcomeFor(sub(VISUAL), enforce, decide, table)
  if (unknownMain.kind === 'enforce' && 'hookSpecificOutput' in unknownMain.output) {
    assert.ok(['GPT-5.4 (copilot)', 'Claude Sonnet 5.5 (copilot)'].includes(unknownMain.output.hookSpecificOutput.updatedInput.model as string))
  } else assert.fail('expected enforce')
  const autoMain = outcomeFor(sub(VISUAL), enforce, decide, table, 'auto')
  if (autoMain.kind === 'enforce' && 'hookSpecificOutput' in autoMain.output) {
    assert.equal(autoMain.output.hookSpecificOutput.updatedInput.model, 'Gemini 3.8 Flash (copilot)')
  } else assert.fail('expected enforce')
  const miniMain = outcomeFor(sub(COUPLED), enforce, decide, table, 'gpt-5-mini')
  if (miniMain.kind === 'enforce' && 'hookSpecificOutput' in miniMain.output) {
    assert.equal(miniMain.output.hookSpecificOutput.updatedInput.model, 'GPT-5 mini (copilot)')
    assert.ok(miniMain.decision.warnings.some(w => w.includes('under-provisioned')))
  } else assert.fail('expected enforce')
  const bare = loadProfilesFrom(JSON.stringify({ version: 1, profiles: [{ id: 'a', model: 'm', capability: 1, cost_tier: 0 }] }))
  assert.equal(outcomeFor(sub('x'), enforce, decide, bare).kind, 'skip')
})

test('invalid profiles and model maps are refused', () => {
  assert.throws(() => loadProfilesFrom('{"version": 2}'))
  assert.throws(() => loadProfilesFrom('{"version": 1, "profiles": [{"id": "a", "model": "m", "capability": 9, "cost_tier": 0}]}'))
  assert.throws(() => loadProfilesFrom('{"version": 1, "profiles": [{"id": "a", "model": "m", "capability": 1, "cost_tier": 0}], "models": []}'))
  assert.throws(() => loadProfilesFrom('{"version": 1, "profiles": [{"id": "a", "model": "m", "capability": 1, "cost_tier": 0}], "models": {"m": {"multiplier": -1}}}'))
})

test('pending decisions: exact session first, oldest VS Code decision as the fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskshape-pending-'))
  try {
    writeJson(dir, 'a', { ts: 10, harness: 'vscode-local', profile: 'old' })
    writeJson(dir, 'b', { ts: 20, harness: 'vscode-local', profile: 'new' })
    writeJson(dir, 'c', { ts: 5, harness: 'copilot-cli', profile: 'cli' })
    assert.equal(popPending(dir, 'b', 'vscode-local')?.profile, 'new')
    assert.equal(popPending(dir, 'zzz', 'copilot-cli'), undefined)
    assert.equal(popPending(dir, 'zzz', 'vscode-local')?.profile, 'old')
    assert.equal(popPending(dir, 'zzz', 'vscode-local'), undefined)
    assert.equal(popPending(dir, 'c', 'copilot-cli')?.profile, 'cli')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const runHook = (script: string, payload: unknown, home: string, extraEnv: Record<string, string> = {}, hooksDir = here) =>
  spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', join(hooksDir, script)],
    { input: JSON.stringify(payload), encoding: 'utf8', env: {
      ...process.env,
      TASKSHAPE_HOME: home,
      TASKSHAPE_MODE: 'enforce',
      TASKSHAPE_BUDGET: '',
      TASKSHAPE_BACKEND: 'heuristic',
      TASKSHAPE_PROFILES: '',
      TASKSHAPE_COMMAND: '',
      TASKSHAPE_CONFIG: '',
      TASKSHAPE_RESPECT_EXPLICIT_MODEL: '',
      TASKSHAPE_ROUTE_NAMED_AGENTS: '',
      TASKSHAPE_DISCOVER_MODELS: 'false',
      TASKSHAPE_COPILOT: '',
      ...extraEnv,
    } })

const installPluginFixture = (dir: string, runtimeSource?: string): string => {
  const root = join(dir, "Task Shape O'Brien ü %23 # plugin")
  const hooks = join(root, 'hooks')
  const runtime = join(root, 'runtime')
  mkdirSync(hooks, { recursive: true })
  mkdirSync(runtime, { recursive: true })
  for (const name of ['discover.ts', 'harness.ts', 'policy.ts', 'pretooluse.ts', 'rubric.ts', 'sessionstart.ts', 'shapes.ts', 'subagentstop.ts']) {
    copyFileSync(join(here, name), join(hooks, name))
  }
  for (const name of ['launch.sh', 'launch.ps1', 'runtime-cli.ts']) copyFileSync(join(here, name), join(hooks, name))
  copyFileSync(nodeAssetsPath, join(runtime, 'node-assets.tsv'))
  if (runtimeSource !== undefined) writeFileSync(join(hooks, 'runtime.ts'), runtimeSource)
  copyFileSync(profilesPath, join(root, 'profiles.copilot.json'))
  return hooks
}

const allPersistedText = (home: string): string =>
  ['decisions.jsonl', 'outcomes.jsonl', join('pending', 's1.json'), join('pending', 'v1.json'), join('pending', 'v2.json'), join('pending', 'v3.json')]
    .map(name => {
      const path = join(home, name)
      return existsSync(path) ? readFileSync(path, 'utf8') : ''
    }).join('\n')

const fakeNodeArchive = (dir: string, marker: string): { baseUrl: string; assets: string } => {
  const platform = platformKey()
  const version = '22.99.0'
  const filename = `node-v${version}-${platform}.tar.xz`
  const root = join(dir, `node-v${version}-${platform}`)
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'node'), `#!/bin/sh
case " $* " in
  *"runtime-cli.ts prepare "*) printf prepared > "${marker}"; exit 0;;
esac
if [ "$1" = "-e" ]; then exit 0; fi
exec "${process.execPath}" "$@"
`, { mode: 0o755 })
  const made = spawnSync('tar', ['-cJf', join(dir, filename), '-C', dir, `node-v${version}-${platform}`], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const archive = readFileSync(join(dir, filename))
  return {
    baseUrl: `file://${dir}`,
    assets: `# platform\tversion\tfilename\tsha256\n${platform}\t${version}\t${filename}\t${createHash('sha256').update(archive).digest('hex')}\n`,
  }
}

test('end to end: the scripts answer both harnesses exactly as the hooks expect', () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    // Copilot CLI sessionStart (no model in the payload): only writes the default config and prints nothing
    const cliStart = runHook('sessionstart.ts', { sessionId: 's1', cwd: '/', timestamp: 1, source: 'new' }, home)
    assert.equal(cliStart.status, 0, cliStart.stderr)
    assert.equal(cliStart.stdout, '')
    assert.equal(JSON.parse(readFileSync(join(home, 'copilot.json'), 'utf8')).mode, 'enforce', 'the file holds the defaults')
    assert.ok(!existsSync(join(home, 'sessions', 's1.json')))
    assert.ok(!existsSync(join(home, 'models.json')), 'discovery is off in this test')
    // Copilot CLI shape
    const cli = runHook('pretooluse.ts', task(COUPLED), home)
    assert.equal(cli.status, 0, cli.stderr)
    const cliOut = JSON.parse(cli.stdout)
    assert.equal(cliOut.permissionDecision, 'allow')
    assert.equal(cliOut.modifiedArgs.reasoning_effort, 'high')
    // VS Code shape, main model unknown
    const local = runHook('pretooluse.ts', sub(TYPO), home)
    assert.equal(local.status, 0, local.stderr)
    assert.equal(JSON.parse(local.stdout).hookSpecificOutput.updatedInput.model, 'GPT-6 Luna (copilot)')
    // VS Code: SessionStart pins the main model, PreToolUse honors the ceiling
    const start = runHook('sessionstart.ts', { session_id: 'v2', source: 'new', model: 'gpt-5-mini', agent_type: 'agent' }, home)
    assert.equal(start.status, 0, start.stderr)
    assert.equal(start.stdout, '')
    const capped = runHook('pretooluse.ts', { ...sub(COUPLED), session_id: 'v2' }, home)
    assert.equal(JSON.parse(capped.stdout).hookSpecificOutput.updatedInput.model, 'GPT-5 mini (copilot)')
    // suggest mode prints nothing (VS Code would warn on non-JSON output)
    const quiet = runHook('pretooluse.ts', { ...sub(COUPLED), session_id: 'v3' }, home, { TASKSHAPE_MODE: 'suggest' })
    assert.equal(quiet.stdout, '')
    // other tools are ignored silently
    assert.equal(runHook('pretooluse.ts', { tool_name: 'read_file', tool_input: { path: 'x' } }, home).stdout, '')
    // SubagentStop for VS Code pops the oldest pending VS Code decision (session v1) even with another session id
    const stop = runHook('subagentstop.ts', { session_id: 'child-9', agent_id: 'a1', agent_type: 'default', stop_hook_active: false }, home)
    assert.equal(stop.status, 0, stop.stderr)
    const stopCli = runHook('subagentstop.ts', { sessionId: 's1', agentType: 'general-purpose', stopReason: 'end_turn', response: 'done' }, home)
    assert.equal(stopCli.status, 0, stopCli.stderr)
    const decisions = readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.ok(decisions.some(d => d.harness === 'copilot-cli' && d.mode === 'enforced'))
    assert.ok(decisions.some(d => d.harness === 'vscode-local' && d.mode === 'enforced' && d.model_name === 'GPT-5 mini (copilot)' && d.main_model === 'gpt-5-mini'))
    assert.ok(decisions.some(d => d.harness === 'vscode-local' && d.mode === 'suggested'))
    assert.ok(decisions.every(d => !('description' in d)), 'decision rows must not persist raw task descriptions')
    const outcomes = readFileSync(join(home, 'outcomes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(outcomes.length, 2)
    assert.ok(outcomes.some(o => o.harness === 'vscode-local' && o.accepted === null && o.model === 'gpt-6-luna'))
    assert.ok(outcomes.some(o => o.harness === 'copilot-cli' && o.accepted === true))
    assert.equal(JSON.parse(readFileSync(join(home, 'copilot.json'), 'utf8')).mode, 'enforce', 'later hooks never rewrite the config')
    const persisted = allPersistedText(home)
    assert.equal(persisted.includes(COUPLED), false, 'persistent files must not contain the raw Copilot prompt')
    assert.equal(persisted.includes(TYPO), false, 'persistent files must not contain the raw VS Code prompt')
    assert.equal(persisted.includes('"description"'), false, 'persistent files must not contain raw descriptions')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('end to end: an installed plugin path with spaces and URL characters still loads bundled profiles', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-install-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp)
    const prompt = 'Own customer export, tests, and rollout plan; coordinate API and UI changes'
    const description = 'Private customer export details #%'
    const cli = runHook('pretooluse.ts', task(prompt, { description }), home, {}, hooks)
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).modifiedArgs.prompt, prompt)
    assert.equal(typeof JSON.parse(cli.stdout).modifiedArgs.model, 'string')
    const local = runHook('pretooluse.ts', sub(prompt, { description }), home, {}, hooks)
    assert.equal(local.status, 0, local.stderr)
    assert.match(JSON.parse(local.stdout).hookSpecificOutput.updatedInput.model, /\(copilot\)$/)
    const persisted = allPersistedText(home)
    assert.equal(persisted.includes(prompt), false)
    assert.equal(persisted.includes(description), false)
    assert.equal(persisted.includes('"description"'), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('launcher uses an existing Node runtime without changing hook stdin', { skip: !POSIX }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-launch-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp)
    const ran = spawnSync('sh', [join(hooks, 'launch.sh'), 'pretooluse.ts'], {
      input: JSON.stringify(task(COUPLED)), encoding: 'utf8',
      env: { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_BACKEND: 'heuristic', TASKSHAPE_DISCOVER_MODELS: 'false' },
    })
    assert.equal(ran.status, 0, ran.stderr)
    const out = JSON.parse(ran.stdout)
    assert.equal(out.modifiedArgs.prompt, COUPLED)
    assert.equal(out.modifiedArgs.reasoning_effort, 'high')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('launcher bootstraps pinned private Node and starts runtime preparation without persisting stdin', { skip: !POSIX || platformKey() === 'unsupported' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-launch-bootstrap-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp)
    const marker = join(tmp, 'prepared.txt')
    const fake = fakeNodeArchive(join(tmp, 'downloads'), marker)
    writeFileSync(join(dirname(hooks), 'runtime', 'node-assets.tsv'), fake.assets)
    const env = { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_BACKEND: 'heuristic', TASKSHAPE_DISCOVER_MODELS: 'false',
      TASKSHAPE_FORCE_BUNDLED_NODE: '1', TASKSHAPE_NODE_BASE_URL: fake.baseUrl }
    const first = spawnSync('sh', [join(hooks, 'launch.sh'), 'pretooluse.ts'], { input: JSON.stringify(task(SECRET_PROMPT)), encoding: 'utf8', env })
    assert.equal(first.status, 0, first.stderr)
    assert.equal(first.stdout, '')
    assert.match(first.stderr, /preparing private Node.js runtime; original model kept/)
    const deadline = Date.now() + 5000
    while (!existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    assert.ok(existsSync(marker), 'Node bootstrap should start runtime-cli prepare after extraction')
    assert.equal(existsSync(join(home, 'decisions.jsonl')), false, 'the skipped first launch must not persist the raw hook payload')
    const second = spawnSync('sh', [join(hooks, 'launch.sh'), 'pretooluse.ts'], { input: JSON.stringify(task(COUPLED)), encoding: 'utf8', env })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(JSON.parse(second.stdout).modifiedArgs.reasoning_effort, 'high')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('launcher reports a failed private Node bootstrap instead of staying permanently pending', { skip: !POSIX || platformKey() === 'unsupported' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-launch-fail-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp)
    const marker = join(tmp, 'prepared.txt')
    const fake = fakeNodeArchive(join(tmp, 'downloads'), marker)
    writeFileSync(join(dirname(hooks), 'runtime', 'node-assets.tsv'), fake.assets.replace(/[a-f0-9]{64}/, '0'.repeat(64)))
    const env = { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_BACKEND: 'heuristic', TASKSHAPE_DISCOVER_MODELS: 'false',
      TASKSHAPE_FORCE_BUNDLED_NODE: '1', TASKSHAPE_NODE_BASE_URL: fake.baseUrl }
    const first = spawnSync('sh', [join(hooks, 'launch.sh'), 'pretooluse.ts'], { input: JSON.stringify(task(COUPLED)), encoding: 'utf8', env })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stderr, /preparing private Node.js runtime/)
    const status = join(home, 'node', 'status.txt')
    const deadline = Date.now() + 5000
    while ((!existsSync(status) || !readFileSync(status, 'utf8').startsWith('error:')) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    assert.match(readFileSync(status, 'utf8'), /checksum mismatch/)
    const second = spawnSync('sh', [join(hooks, 'launch.sh'), 'pretooluse.ts'], { input: JSON.stringify(task(COUPLED)), encoding: 'utf8', env })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.stdout, '')
    assert.match(second.stderr, /private Node.js setup failed: Node.js checksum mismatch; original model kept/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('plugin hook manifests invoke the Node bootstrap launchers', () => {
  const vscodeManifest = [join(here, '..', 'vscode', 'hooks', 'hooks.json'), join(here, '..', '..', 'vscode', 'hooks', 'hooks.json')].find(p => existsSync(p)) as string
  const copilotManifest = [join(here, '..', 'copilot', 'hooks.json'), join(here, '..', '..', 'copilot', 'hooks.json')].find(p => existsSync(p)) as string
  const vscode = JSON.parse(readFileSync(vscodeManifest, 'utf8'))
  const copilot = JSON.parse(readFileSync(copilotManifest, 'utf8'))
  const vscodeHooks = [
    vscode.hooks.PreToolUse[0].hooks[0],
    vscode.hooks.SessionStart[0].hooks[0],
    vscode.hooks.SubagentStop[0].hooks[0],
  ]
  for (const hook of vscodeHooks) {
    assert.match(String(hook.bash ?? hook.command), new RegExp('hooks/launch\\.sh'))
    assert.match(String(hook.powershell), new RegExp('launch\\.ps1'))
    assert.doesNotMatch(String(hook.command), /^node /)
  }
  for (const event of ['sessionStart', 'preToolUse', 'subagentStop']) {
    const hook = copilot.hooks[event][0]
    assert.match(String(hook.bash), new RegExp('hooks/launch\\.sh'))
    assert.match(String(hook.powershell), new RegExp('launch\\.ps1'))
    assert.equal('exec' in hook, false)
  }
})

test('default Laya backend keeps the original model when runtime is unavailable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-laya-missing-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp)
    const ran = runHook('pretooluse.ts', task('Own billing rollout and tests'), home, { TASKSHAPE_BACKEND: 'laya' }, hooks)
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
    assert.match(ran.stderr, /Taskshape: laya unavailable: .*original model kept/)
    const row = JSON.parse(readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim())
    assert.equal(row.mode, 'skipped')
    assert.equal(row.backend, 'laya')
    assert.match(row.error, /laya unavailable/)
    assert.equal('model' in row, false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('Laya backend uses local classification metadata for Copilot and VS Code rewrites', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-laya-ready-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp, `
      export const classifyLocal = async () => ({ source: 'laya', shape: 'coupled', answer_confidence: 0.91, shape_probabilities: { search: 0.01, simple: 0.02, debugging: 0.02, visual: 0.01, coupled: 0.91, architecture: 0.03 } })
      export const ensureRuntime = async () => ({ state: 'ready', message: 'mock ready', python: 'py', checkpoint: 'ckpt' })
    `)
    const cli = runHook('pretooluse.ts', task('Fix only a typo'), home, { TASKSHAPE_BACKEND: 'laya' }, hooks)
    assert.equal(cli.status, 0, cli.stderr)
    const cliOut = JSON.parse(cli.stdout)
    assert.ok(['claude-sonnet-5.5', 'gpt-5.4'].includes(cliOut.modifiedArgs.model))
    assert.equal(cliOut.modifiedArgs.reasoning_effort, 'high')
    const local = runHook('pretooluse.ts', sub('Fix only a typo'), home, { TASKSHAPE_BACKEND: 'laya' }, hooks)
    assert.equal(local.status, 0, local.stderr)
    assert.match(JSON.parse(local.stdout).hookSpecificOutput.updatedInput.model, /Claude Sonnet 5\.5|GPT-5\.4/)
    const rows = readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.backend, 'laya')
      assert.equal(row.source, 'laya')
      assert.equal(row.shape, 'coupled')
      assert.equal(row.shape_probabilities.coupled, 0.91)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('Laya backend does not fall back to heuristic routing after classification failure', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-laya-fail-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp, `
      export const classifyLocal = async () => { throw new Error('mock runtime not ready') }
      export const ensureRuntime = async () => ({ state: 'installing', message: 'mock installing' })
    `)
    const ran = runHook('pretooluse.ts', task(COUPLED), home, { TASKSHAPE_BACKEND: 'laya' }, hooks)
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
    assert.match(ran.stderr, /mock runtime not ready.*original model kept/)
    const row = JSON.parse(readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim())
    assert.equal(row.mode, 'skipped')
    assert.equal(row.backend, 'laya')
    assert.match(row.error, /mock runtime not ready/)
    assert.equal('shape' in row, false)
    assert.equal('model' in row, false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('command backend failures keep the original model and do not fall back to embedded routing', () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const ran = runHook('pretooluse.ts', task(COUPLED), home, { TASKSHAPE_COMMAND: join(home, 'missing-taskshape-command') })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
    assert.match(ran.stderr, /Taskshape: routing failed: .*original model kept/)
    const row = JSON.parse(readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim())
    assert.equal(row.mode, 'skipped')
    assert.equal(row.backend, 'command')
    assert.match(row.error, /routing failed/)
    assert.equal('shape' in row, false)
    assert.equal('model' in row, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('command backend passes private prompt through stdin instead of argv', { skip: !POSIX }, () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  const bin = mkdtempSync(join(tmpdir(), 'taskshape-command-'))
  const command = join(bin, 'taskshape-fake.mjs')
  const capture = join(bin, 'capture.json')
  try {
    writeFileSync(command, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const stdin = readFileSync(0, 'utf8')
writeFileSync(process.env.TASKSHAPE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin }))
process.stdout.write(JSON.stringify({ task: '', phase: 'work', shape: 'coupled', profile: 'sonnet', model: 'claude-sonnet-5.5', effort: 'high', reason: 'fake', source: 'fake', answer_confidence: 0.9, warnings: [] }))
`, { mode: 0o755 })
    const ran = runHook('pretooluse.ts', sub(SECRET_PROMPT, { description: SECRET_DESCRIPTION }), home, {
      TASKSHAPE_COMMAND: command,
      TASKSHAPE_CAPTURE: capture,
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(JSON.parse(ran.stdout).hookSpecificOutput.updatedInput.prompt, SECRET_PROMPT)
    const recorded = JSON.parse(readFileSync(capture, 'utf8'))
    assert.equal(recorded.stdin, SECRET_PROMPT)
    assert.ok(recorded.argv.includes('--task-stdin'))
    assert.equal(recorded.argv.includes('--task'), false)
    assert.equal(JSON.stringify(recorded.argv).includes(SECRET_PROMPT), false)
    assert.equal(allPersistedText(home).includes(SECRET_PROMPT), false)
    assert.equal(allPersistedText(home).includes(SECRET_DESCRIPTION), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
})

test('SessionStart starts Laya setup and reports status to VS Code context', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape-laya-start-'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooks = installPluginFixture(tmp, `
      export const ensureRuntime = async () => ({ state: 'installing', message: 'mock setup running', python: 'py', checkpoint: 'ckpt' })
      export const classifyLocal = async () => { throw new Error('unused') }
    `)
    const cli = runHook('sessionstart.ts', { sessionId: 's1', cwd: '/', timestamp: 1, source: 'new' }, home, { TASKSHAPE_BACKEND: 'laya' }, hooks)
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(cli.stdout, '')
    assert.match(cli.stderr, /taskshape runtime installing: mock setup running/)
    const local = runHook('sessionstart.ts', { session_id: 'v1', source: 'new', model: 'gpt-5-mini' }, home, { TASKSHAPE_BACKEND: 'laya' }, hooks)
    assert.equal(local.status, 0, local.stderr)
    assert.match(local.stderr, /taskshape runtime installing: mock setup running/)
    const out = JSON.parse(local.stdout)
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(out.hookSpecificOutput.additionalContext, /taskshape runtime installing: mock setup running/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('end to end: SessionStart discovers the account models through the CLI and both harnesses route within them', { skip: !POSIX }, () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const env = { TASKSHAPE_DISCOVER_MODELS: 'true', TASKSHAPE_COPILOT: fakeCopilot(join(home, 'bin'), ACP_MODELS) }
    const start = runHook('sessionstart.ts', { sessionId: 's1', cwd: '/', timestamp: 1, source: 'new' }, home, env)
    assert.equal(start.status, 0, start.stderr)
    assert.equal(start.stdout, '')
    const catalog = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    assert.equal(catalog.source, 'copilot-acp')
    assert.deepEqual(Object.keys(catalog.models).sort(), ['auto', 'claude-haiku-4.5', 'claude-sonnet-5.5', 'gpt-5-mini'])
    assert.ok(!existsSync(join(home, 'models.lock')), 'the lock is released')
    // a fresh catalog is reused: point the CLI at a hanging fake, routing must still answer at once
    const hangEnv = { TASKSHAPE_DISCOVER_MODELS: 'true', TASKSHAPE_COPILOT: fakeCopilot(join(home, 'hang'), 'hang') }
    const started = Date.now()
    const cli = runHook('pretooluse.ts', task(TYPO), home, hangEnv)
    assert.equal(cli.status, 0, cli.stderr)
    assert.ok(Date.now() - started < 5000, 'no discovery while the catalog is fresh')
    assert.equal(JSON.parse(cli.stdout).modifiedArgs.model, 'claude-haiku-4.5', 'gpt-6-luna is not offered, so the cheapest adequate offered model wins')
    const local = runHook('pretooluse.ts', sub(COUPLED), home, hangEnv)
    assert.equal(JSON.parse(local.stdout).hookSpecificOutput.updatedInput.model, 'Claude Sonnet 5.5 (copilot)')
    const rows = readFileSync(join(home, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.catalog.models, 4)
      assert.ok(row.unavailable_profiles.includes('gpt-6-luna'))
    }
    // a stale catalog is refreshed on the next session start; a failed refresh keeps the models and notes the error
    writeFileSync(join(home, 'models.json'), JSON.stringify({ ...catalog, ts: catalog.ts - CATALOG_TTL - 1 }))
    const again = runHook('sessionstart.ts', { sessionId: 's2', cwd: '/', timestamp: 2 }, home, { ...hangEnv, TASKSHAPE_DISCOVERY_TIMEOUT_MS: '500' })
    assert.equal(again.status, 0, again.stderr)
    const kept = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    assert.deepEqual(Object.keys(kept.models).sort(), Object.keys(catalog.models).sort())
    assert.match(kept.error ?? '', /did not answer/)
    assert.ok(kept.ts > catalog.ts)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('VS Code hooks.json: the shell pre-filter runs the hook only for runSubagent', { skip: !existsSync(join(here, 'hooks.json')) || process.platform === 'win32' }, () => {
  const hooks = JSON.parse(readFileSync(join(here, 'hooks.json'), 'utf8'))
  const entry = hooks.hooks.PreToolUse[0].hooks[0]
  const command = String(entry.bash).replaceAll('${CLAUDE_PLUGIN_ROOT}', join(here, '..'))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const env = { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_MODE: 'enforce', TASKSHAPE_BACKEND: 'heuristic', TASKSHAPE_COMMAND: '', TASKSHAPE_DISCOVER_MODELS: 'false' }
    const hit = spawnSync('sh', ['-c', command], { input: JSON.stringify(sub(COUPLED)), encoding: 'utf8', env })
    assert.equal(hit.status, 0, hit.stderr)
    assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecision, 'allow')
    const logged = readFileSync(join(home, 'decisions.jsonl'), 'utf8')
    const miss = spawnSync('sh', ['-c', command], { input: JSON.stringify({ tool_name: 'read_file', tool_input: { path: 'x' } }), encoding: 'utf8', env })
    assert.equal(miss.status, 0, miss.stderr)
    assert.equal(miss.stdout, '')
    assert.equal(readFileSync(join(home, 'decisions.jsonl'), 'utf8'), logged, 'the pre-filter must not even start node for other tools')
    for (const event of ['SessionStart', 'SubagentStop']) {
      const cmd = String(hooks.hooks[event][0].hooks[0].command)
      assert.ok(cmd.includes('${CLAUDE_PLUGIN_ROOT}/hooks/'), `${event} command must address the plugin root token`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('VS Code hooks.json: PowerShell pre-filter runs hooks from a plugin path with spaces', { skip: process.platform !== 'win32' || !existsSync(join(here, 'hooks.json')) }, () => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' })
  assert.equal(pwsh.status, 0, pwsh.stderr)
  const hooks = JSON.parse(readFileSync(join(here, 'hooks.json'), 'utf8'))
  const startCommand = String(hooks.hooks.SessionStart[0].hooks[0].powershell)
  const preCommand = String(hooks.hooks.PreToolUse[0].hooks[0].powershell)
  const stopCommand = String(hooks.hooks.SubagentStop[0].hooks[0].powershell)
  const tmp = mkdtempSync(join(tmpdir(), 'taskshape pwsh ü '))
  const home = mkdtempSync(join(tmpdir(), 'taskshape-home-'))
  try {
    const hooksDir = installPluginFixture(tmp)
    const pluginRoot = dirname(hooksDir)
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      TASKSHAPE_HOME: home,
      TASKSHAPE_MODE: 'enforce',
      TASKSHAPE_BUDGET: '',
      TASKSHAPE_BACKEND: 'heuristic',
      TASKSHAPE_PROFILES: '',
      TASKSHAPE_COMMAND: '',
      TASKSHAPE_CONFIG: '',
      TASKSHAPE_RESPECT_EXPLICIT_MODEL: '',
      TASKSHAPE_ROUTE_NAMED_AGENTS: '',
      TASKSHAPE_DISCOVER_MODELS: 'false',
      TASKSHAPE_COPILOT: '',
    }
    const start = spawnSync('pwsh', ['-NoProfile', '-Command', startCommand], {
      input: JSON.stringify({ session_id: 'pwsh-v1', source: 'new', model: 'gpt-5-mini', agent_type: 'agent' }), encoding: 'utf8', env })
    assert.equal(start.status, 0, start.stderr)
    assert.equal(start.stdout, '')
    const hit = spawnSync('pwsh', ['-NoProfile', '-Command', preCommand], { input: JSON.stringify({ ...sub(COUPLED), session_id: 'pwsh-v1' }), encoding: 'utf8', env })
    assert.equal(hit.status, 0, hit.stderr)
    const output = JSON.parse(hit.stdout)
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow')
    assert.equal(output.hookSpecificOutput.updatedInput.model, 'GPT-5 mini (copilot)')
    const logged = readFileSync(join(home, 'decisions.jsonl'), 'utf8')
    const row = JSON.parse(logged.trim())
    assert.equal(row.main_model, 'gpt-5-mini')
    assert.equal(row.model_name, 'GPT-5 mini (copilot)')
    const miss = spawnSync('pwsh', ['-NoProfile', '-Command', preCommand], { input: JSON.stringify({ tool_name: 'read_file', tool_input: { path: 'x' } }), encoding: 'utf8', env })
    assert.equal(miss.status, 0, miss.stderr)
    assert.equal(miss.stdout, '')
    assert.equal(readFileSync(join(home, 'decisions.jsonl'), 'utf8'), logged, 'the pre-filter must not start node for other tools')
    const stop = spawnSync('pwsh', ['-NoProfile', '-Command', stopCommand], {
      input: JSON.stringify({ session_id: 'pwsh-v1', agent_id: 'a1', agent_type: 'default', stop_hook_active: false }), encoding: 'utf8', env })
    assert.equal(stop.status, 0, stop.stderr)
    assert.equal(stop.stdout, '')
    const outcome = JSON.parse(readFileSync(join(home, 'outcomes.jsonl'), 'utf8').trim())
    assert.equal(outcome.harness, 'vscode-local')
    assert.equal(outcome.model, 'gpt-5-mini')
    assert.equal(outcome.accepted, null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
