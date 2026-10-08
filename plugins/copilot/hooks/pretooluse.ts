// PreToolUse hook for sub-agent launches. Copilot CLI sends `{ toolName: "task", toolArgs }`; VS Code's
// agent mode sends `{ tool_name: "runSubagent", tool_input }`. Stdin JSON in; JSON out only in enforce mode.
// Runs with `node --experimental-strip-types`; no dependencies beyond Node 22.6+.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG, type Config, type Decide, type Decision, type HookInput, type LocalInput, appendLine, applyCatalog, dataDir, dataPaths,
  detectHarness, ensureConfig, loadProfilesFrom, originFor, outcomeFor, parseConfig, readJson, routeClassified, routeEmbedded, sessionModel, writeJson,
} from './harness.ts'
import { refreshCatalog } from './discover.ts'
import type { Profile } from './policy.ts'
import type { Shape } from './shapes.ts'

const here = dirname(fileURLToPath(import.meta.url))
const bundledProfilesPath = (): string =>
  [join(here, '..', 'profiles.copilot.json'), join(here, 'profiles.copilot.json')].find(path => existsSync(path))
    ?? join(here, '..', 'profiles.copilot.json')

const routeWithCli = (config: Config, profilesPath: string, prompt: string, candidates: readonly Profile[], all: readonly Profile[]): Decision => {
  const argv = ['route', '--profiles', profilesPath, '--budget', config.budget, '--phase', 'work', '--task-stdin', '--origin', 'copilot-plugin']
  if (config.config) argv.push('--config', config.config)
  if (candidates.length !== all.length) argv.push('--allowed', candidates.map(p => p.id).join(','))
  const ran = spawnSync(config.command, argv, { input: prompt, encoding: 'utf8', timeout: 25000 })
  if (ran.status !== 0) throw new Error('taskshape command failed; original model kept')
  let parsed: Decision
  try { parsed = JSON.parse(ran.stdout) as Decision } catch { throw new Error('taskshape command returned invalid JSON') }
  parsed.source = `cli:${parsed.source}`
  return parsed
}

type LayaClassification = { shape: Shape; answer_confidence: number; shape_probabilities?: Record<string, number>; source: 'laya' }

const classifyWithLaya = async (prompt: string): Promise<LayaClassification> => {
  const runtime = await import('./runtime.ts') as { classifyLocal: (prompt: string) => Promise<LayaClassification> }
  return runtime.classifyLocal(prompt)
}

const promptToClassify = (input: HookInput, config: Config, harness: ReturnType<typeof detectHarness>): string | undefined => {
  if (harness === 'copilot-cli') {
    const args = (input as { toolName?: string; toolArgs?: Record<string, unknown> }).toolArgs ?? {}
    if ((input as { toolName?: string }).toolName !== 'task') return undefined
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return undefined
    if (config.respectExplicitModel && typeof args.model === 'string' && args.model && args.model !== 'auto') return undefined
    return args.prompt
  }
  if (harness === 'vscode-local') {
    const args = (input as LocalInput).tool_input ?? {}
    if ((input as LocalInput).tool_name !== 'runSubagent') return undefined
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return undefined
    if (config.respectExplicitModel && typeof args.model === 'string' && args.model.trim()) return undefined
    if (!config.routeNamedAgents && typeof args.agentName === 'string' && args.agentName.trim()) return undefined
    return args.prompt
  }
  return undefined
}

const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 200)

const main = async () => {
  let input: HookInput
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput
  } catch {
    return
  }
  const harness = detectHarness(input)
  if (harness === 'unknown') return
  const dir = dataDir()
  const paths = dataPaths(dir)
  const origin = originFor(harness)
  ensureConfig(paths.config)
  const config = parseConfig(readJson(paths.config) ?? DEFAULT_CONFIG, process.env)
  const profilesPath = config.profiles || bundledProfilesPath()
  const warnings: string[] = []
  let shipped
  try {
    shipped = loadProfilesFrom(readFileSync(profilesPath, 'utf8'))
  } catch (error) {
    appendLine(paths.decisions, { ts: Date.now() / 1000, origin, harness, mode: 'skipped', error: `profiles unusable: ${String(error).slice(0, 160)}` })
    return
  }
  // the account's catalog (discovered through the Copilot CLI) narrows the table to models that can actually launch
  const catalog = await refreshCatalog(paths, config, dir)
  const applied = applyCatalog(shipped, catalog)
  const table = applied.table
  if (applied.warning) warnings.push(applied.warning)
  const sessionId = harness === 'vscode-local' ? (input as LocalInput).session_id : (input as { sessionId?: string }).sessionId
  const mainModel = harness === 'vscode-local' ? sessionModel(paths.sessions, sessionId) : undefined
  let classification: LayaClassification | undefined
  const classifyPrompt = config.command || config.backend === 'heuristic' ? undefined : promptToClassify(input, config, harness)
  if (classifyPrompt) {
    try {
      classification = await classifyWithLaya(classifyPrompt)
    } catch (error) {
      process.stderr.write(`Taskshape: laya unavailable: ${errorText(error)}; original model kept\n`)
      appendLine(paths.decisions, { ts: Date.now() / 1000, origin, harness, mode: 'skipped', sessionId: sessionId ?? null,
        backend: config.backend, error: `laya unavailable: ${errorText(error)}` })
      return
    }
  }
  const decide: Decide = (prompt, candidates) => {
    if (config.command) {
      return routeWithCli(config, profilesPath, prompt, candidates, shipped.profiles)
    }
    if (config.backend === 'laya') {
      if (!classification) throw new Error('laya classification was not prepared')
      return routeClassified(prompt, 'work', table, config.budget, classification.shape, classification.answer_confidence,
        classification.source, candidates, classification.shape_probabilities)
    }
    return routeEmbedded(prompt, 'work', table, config.budget, candidates)
  }
  let outcome
  try {
    outcome = outcomeFor(input, config, decide, table, mainModel)
  } catch (error) {
    process.stderr.write(`Taskshape: routing failed: ${errorText(error)}; original model kept\n`)
    appendLine(paths.decisions, { ts: Date.now() / 1000, origin, harness, mode: 'skipped', sessionId: sessionId ?? null,
      backend: config.command ? 'command' : config.backend, error: `routing failed: ${errorText(error)}` })
    return
  }
  if (outcome.kind === 'skip') {
    appendLine(paths.decisions, { ts: Date.now() / 1000, origin, harness, mode: 'skipped', why: outcome.why, sessionId: sessionId ?? null })
    return
  }
  const decision = outcome.decision
  decision.warnings = [...(decision.warnings ?? []), ...warnings]
  const args = harness === 'vscode-local' ? ((input as LocalInput).tool_input ?? {}) : ((input as { toolArgs?: Record<string, unknown> }).toolArgs ?? {})
  const row = { ts: Date.now() / 1000, origin, harness, mode: outcome.kind === 'enforce' ? 'enforced' : 'suggested', sessionId: sessionId ?? null,
    phase: decision.phase, shape: decision.shape, profile: decision.profile, model: decision.model, model_name: decision.model_name ?? null,
    effort: decision.effort, answer_confidence: decision.answer_confidence, source: decision.source, reason: decision.reason, warnings: decision.warnings,
    backend: config.command ? 'command' : config.backend, shape_probabilities: decision.shape_probabilities ?? null,
    main_model: mainModel ?? null, agent_type: (args.agent_type as string | undefined) ?? (args.agentName as string | undefined) ?? null,
    catalog: catalog && Object.keys(catalog.models).length > 0 ? { source: catalog.source, ts: catalog.ts, models: Object.keys(catalog.models).length, error: catalog.error ?? null } : null,
    unavailable_profiles: applied.dropped }
  appendLine(paths.decisions, row)
  if (sessionId) writeJson(paths.pending, sessionId, row)
  if (outcome.kind === 'enforce') process.stdout.write(JSON.stringify(outcome.output))
}

main().catch(() => {
  // best effort: the launch goes through unchanged
})
