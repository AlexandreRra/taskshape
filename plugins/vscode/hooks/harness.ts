// Routing logic shared by the Copilot CLI and VS Code plugins. The same hook scripts serve both harnesses:
// Copilot CLI (and Copilot CLI sessions inside VS Code) send `{ toolName, toolArgs }` and apply
// `{ permissionDecision: "allow", modifiedArgs }`; VS Code's own agent mode (the "Local" harness) sends
// `{ tool_name, tool_input }` and applies `hookSpecificOutput.updatedInput`. Pure functions live here so
// `node --test` covers them; file I/O helpers are small and best effort (a hook must never break a launch).
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { classify } from './rubric.ts'
import { type ModelInfo, type Profile, type Table, choose, validateProfiles } from './policy.ts'
import type { Phase, Shape } from './shapes.ts'

export type Mode = 'suggest' | 'enforce'
export type Backend = 'laya' | 'heuristic'

export type Config = {
  mode: Mode
  budget: string
  backend: Backend // default Laya runtime; set heuristic for the embedded rubric
  profiles: string // path to a profiles.json; empty = the plugin's profiles.copilot.json
  command: string // path to the Python taskshape CLI; empty = the selected backend
  config: string // taskshape.json for the Python side
  respectExplicitModel: boolean // a launch that already names a model is left alone
  routeNamedAgents: boolean // VS Code only: route launches of a named custom agent (which may pin its own model)
  discoverModels: boolean // ask the Copilot CLI for the account's models (names, multipliers) and route only within them
  copilot: string // the Copilot CLI command used for that discovery
}

export const DEFAULT_CONFIG: Config = {
  mode: 'enforce', budget: 'default', backend: 'laya', profiles: '', command: '', config: '', respectExplicitModel: true, routeNamedAgents: false,
  discoverModels: true, copilot: 'copilot',
}

/** Contents of the config file the hooks write on first run, so the user edits a value instead of creating the folder and file. */
export const configTemplate = (): string => JSON.stringify({
  note: 'taskshape settings for the Copilot CLI and VS Code plugins, written on first run and never overwritten. '
    + 'mode: "enforce" rewrites the sub-agent model, "suggest" only logs each decision. '
    + 'budget: a name from the profiles table ("economy", "standard", "default"). backend: "laya" or "heuristic". '
    + "profiles: path to your own profiles.json (empty: the plugin's profiles.copilot.json). "
    + 'command: path to the Python taskshape CLI (empty: the selected backend). config: taskshape.json for that CLI. '
    + 'respectExplicitModel: leave a launch that already names a model alone. '
    + 'routeNamedAgents (VS Code): also route launches of named custom agents. '
    + 'discoverModels: once a day ask the Copilot CLI (copilot --acp, no model call) which models the account offers, with their '
    + 'names and usage multipliers, and route only within them (cache: models.json next to this file). copilot: that CLI command. '
    + 'Environment variables TASKSHAPE_MODE, TASKSHAPE_BUDGET, TASKSHAPE_PROFILES, TASKSHAPE_COMMAND, TASKSHAPE_CONFIG, '
    + 'TASKSHAPE_BACKEND, TASKSHAPE_RESPECT_EXPLICIT_MODEL, TASKSHAPE_ROUTE_NAMED_AGENTS, TASKSHAPE_DISCOVER_MODELS and TASKSHAPE_COPILOT override this file.',
  ...DEFAULT_CONFIG,
}, null, 2) + '\n'

/** Copilot CLI `task` tool arguments. */
export type TaskArgs = {
  name?: string
  agent_type?: string
  description?: string
  prompt?: string
  model?: string
  reasoning_effort?: string
  [key: string]: unknown
}

/** VS Code `runSubagent` tool input: `model` is written as "Model Name (copilot)". */
export type SubagentInput = {
  prompt?: string
  description?: string
  agentName?: string
  model?: string
  [key: string]: unknown
}

export type CliInput = { sessionId?: string; timestamp?: number; cwd?: string; toolName?: string; toolArgs?: TaskArgs }
export type LocalInput = {
  session_id?: string; hook_event_name?: string; timestamp?: string; cwd?: string; transcript_path?: string
  tool_name?: string; tool_input?: SubagentInput; tool_use_id?: string
}
export type HookInput = CliInput | LocalInput

export type Harness = 'copilot-cli' | 'vscode-local' | 'unknown'

export const detectHarness = (input: unknown): Harness => {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (typeof v.toolName === 'string') return 'copilot-cli'
  if (typeof v.tool_name === 'string') return 'vscode-local'
  return 'unknown'
}

export const originFor = (harness: Harness): string => (harness === 'vscode-local' ? 'vscode-plugin' : 'copilot-plugin')

export type Decision = {
  task: string
  phase: Phase
  shape: Shape
  profile: string
  model: string
  model_name?: string // the harness-facing name when it differs from the id (VS Code)
  effort: string
  reason: string
  source: string
  answer_confidence: number
  warnings: string[]
  shape_probabilities?: Record<string, number>
}

export type CliOutput = { permissionDecision: 'allow'; permissionDecisionReason: string; modifiedArgs: TaskArgs }
export type LocalOutput = {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; permissionDecisionReason: string; updatedInput: SubagentInput }
}

export type Outcome =
  | { kind: 'skip'; why: string }
  | { kind: 'suggest'; decision: Decision }
  | { kind: 'enforce'; decision: Decision; output: CliOutput | LocalOutput }

/** How a decision is produced: from the prompt and the profiles still eligible in this harness/session. */
export type Decide = (prompt: string, candidates: readonly Profile[]) => Decision

const RUBRIC_CONFIDENCE = 0.7
const VENDOR = 'copilot'

export const parseConfig = (raw: unknown, env: Record<string, string | undefined> = {}): Config => {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (key: 'mode' | 'budget' | 'backend' | 'profiles' | 'command' | 'config' | 'copilot', envName: string): string => {
    const fromEnv = env[envName]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    const fromFile = value[key]
    return typeof fromFile === 'string' ? fromFile : String(DEFAULT_CONFIG[key])
  }
  const flag = (key: 'respectExplicitModel' | 'routeNamedAgents' | 'discoverModels', envName: string): boolean => {
    const fromEnv = env[envName]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv !== 'false'
    return typeof value[key] === 'boolean' ? (value[key] as boolean) : DEFAULT_CONFIG[key]
  }
  const mode = pick('mode', 'TASKSHAPE_MODE')
  const backend = pick('backend', 'TASKSHAPE_BACKEND')
  return {
    mode: mode === 'suggest' ? 'suggest' : mode === 'enforce' ? 'enforce' : DEFAULT_CONFIG.mode,
    budget: pick('budget', 'TASKSHAPE_BUDGET'),
    backend: backend === 'heuristic' ? 'heuristic' : backend === 'laya' ? 'laya' : DEFAULT_CONFIG.backend,
    profiles: pick('profiles', 'TASKSHAPE_PROFILES'),
    command: pick('command', 'TASKSHAPE_COMMAND'),
    config: pick('config', 'TASKSHAPE_CONFIG'),
    respectExplicitModel: flag('respectExplicitModel', 'TASKSHAPE_RESPECT_EXPLICIT_MODEL'),
    routeNamedAgents: flag('routeNamedAgents', 'TASKSHAPE_ROUTE_NAMED_AGENTS'),
    discoverModels: flag('discoverModels', 'TASKSHAPE_DISCOVER_MODELS'),
    copilot: pick('copilot', 'TASKSHAPE_COPILOT') || DEFAULT_CONFIG.copilot,
  }
}

export const loadProfilesFrom = (text: string): Table => validateProfiles(JSON.parse(text))

/**
 * The cost-tier ceiling of a named budget. A name the table does not define (a typo such as "econony") throws instead of
 * silently routing under another budget; the hook then keeps the original model and logs the error. Only the built-in
 * "default" falls back to the widest ceiling when a custom table does not define it.
 */
export const budgetCap = (table: Table, budget: string): number => {
  if (Object.hasOwn(table.budgets, budget)) return table.budgets[budget].max_cost_tier
  if (budget === 'default') return 5
  throw new Error(`unknown budget "${budget.slice(0, 40)}"; known: ${Object.keys(table.budgets).join(', ')}`)
}

export const routeEmbedded = (task: string, phase: Phase, table: Table, budget: string, candidates?: readonly Profile[]): Decision => {
  const cap = budgetCap(table, budget)
  const shape = classify(task, phase)
  const choice = choose(shape, candidates ?? table.profiles, phase, cap)
  return { task: task.slice(0, 500), phase, shape, profile: choice.profile.id, model: choice.profile.model,
    effort: choice.profile.effort ?? 'default', reason: choice.reason, source: 'rubric', answer_confidence: RUBRIC_CONFIDENCE,
    warnings: [...choice.warnings] }
}

export const routeClassified = (task: string, phase: Phase, table: Table, budget: string, shape: Shape,
  answerConfidence: number, source: string, candidates?: readonly Profile[], shapeProbabilities?: Record<string, number>): Decision => {
  const cap = budgetCap(table, budget)
  const choice = choose(shape, candidates ?? table.profiles, phase, cap)
  return { task: task.slice(0, 500), phase, shape, profile: choice.profile.id, model: choice.profile.model,
    effort: choice.profile.effort ?? 'default', reason: `classified as ${shape}; ${choice.reason}`, source,
    answer_confidence: answerConfidence, warnings: [...choice.warnings], shape_probabilities: shapeProbabilities }
}

/** Model maps are keyed by ids from files and the Copilot CLI: only own keys count, never `constructor` or `toString`. */
const ownInfo = (models: Record<string, ModelInfo>, id: string): ModelInfo | undefined => (Object.hasOwn(models, id) ? models[id] : undefined)

/** The name VS Code resolves (`lookupLanguageModelByQualifiedName`): "<name> (<vendor>)". */
export const vscodeModelName = (table: Table, modelId: string): string | undefined => {
  const name = ownInfo(table.models, modelId)?.name
  return name ? `${name} (${VENDOR})` : undefined
}

/**
 * VS Code refuses a sub-agent whose usage multiplier exceeds the session's main model. The main model comes
 * from the SessionStart hook; unknown ids are assumed 1x (the common case), ids listed without a multiplier
 * (such as "auto") impose no ceiling.
 */
export const multiplierCeiling = (table: Table, mainModel: string | undefined): number => {
  if (!mainModel) return 1
  const info = ownInfo(table.models, mainModel.replace(/^copilot\//, ''))
  if (!info) return 1
  return info.multiplier === undefined ? Number.POSITIVE_INFINITY : info.multiplier
}

/** Profiles VS Code can actually launch: a known display name and a multiplier within the ceiling. */
export const localCandidates = (table: Table, ceiling: number): Profile[] =>
  table.profiles.filter(p => {
    const info = ownInfo(table.models, p.model)
    return !!info?.name && (info.multiplier ?? 1) <= ceiling
  })

const describe = (d: Decision, modelLabel: string): string =>
  `taskshape: ${d.shape} -> ${d.profile} (${modelLabel}${d.effort && d.effort !== 'default' ? ' ' + d.effort : ''}, ${d.source})`

const cliOutcome = (input: CliInput, config: Config, decide: Decide, table: Table): Outcome => {
  if (input.toolName !== 'task') return { kind: 'skip', why: `tool ${input.toolName ?? '?'} is not task` }
  const args = input.toolArgs ?? {}
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) return { kind: 'skip', why: 'task has no prompt' }
  if (config.respectExplicitModel && typeof args.model === 'string' && args.model && args.model !== 'auto') {
    return { kind: 'skip', why: `explicit model ${args.model} kept` }
  }
  const decided = decide(args.prompt, table.profiles)
  if (config.mode !== 'enforce') return { kind: 'suggest', decision: decided }
  const modifiedArgs: TaskArgs = { ...args, model: decided.model }
  if (decided.effort && decided.effort !== 'default') modifiedArgs.reasoning_effort = decided.effort
  else delete modifiedArgs.reasoning_effort
  return { kind: 'enforce', decision: decided,
    output: { permissionDecision: 'allow', permissionDecisionReason: describe(decided, decided.model), modifiedArgs } }
}

const localOutcome = (input: LocalInput, config: Config, decide: Decide, table: Table, mainModel: string | undefined): Outcome => {
  if (input.tool_name !== 'runSubagent') return { kind: 'skip', why: `tool ${input.tool_name ?? '?'} is not runSubagent` }
  const args = input.tool_input ?? {}
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) return { kind: 'skip', why: 'runSubagent has no prompt' }
  if (config.respectExplicitModel && typeof args.model === 'string' && args.model.trim()) {
    return { kind: 'skip', why: `explicit model ${args.model} kept` }
  }
  if (!config.routeNamedAgents && typeof args.agentName === 'string' && args.agentName.trim()) {
    return { kind: 'skip', why: `named agent ${args.agentName} keeps its own model (routeNamedAgents is off)` }
  }
  const ceiling = multiplierCeiling(table, mainModel)
  const candidates = localCandidates(table, ceiling)
  if (candidates.length === 0) {
    return { kind: 'skip', why: `no profile has a VS Code model name within the session ceiling of ${ceiling}x (main model ${mainModel ?? 'unknown'})` }
  }
  const decided = decide(args.prompt, candidates)
  const name = vscodeModelName(table, decided.model)
  if (!name) return { kind: 'skip', why: `profile ${decided.profile} has no VS Code model name` }
  decided.model_name = name
  if (config.mode !== 'enforce') return { kind: 'suggest', decision: decided }
  return { kind: 'enforce', decision: decided,
    output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      permissionDecisionReason: describe(decided, name), updatedInput: { ...args, model: name } } } }
}

/** Turn a launch into the hook's answer for whichever harness sent it. */
export const outcomeFor = (input: HookInput, config: Config, decide: Decide, table: Table, mainModel?: string): Outcome => {
  const harness = detectHarness(input)
  if (harness === 'copilot-cli') return cliOutcome(input as CliInput, config, decide, table)
  if (harness === 'vscode-local') return localOutcome(input as LocalInput, config, decide, table, mainModel)
  return { kind: 'skip', why: 'unrecognized hook payload' }
}

// ---- small, best-effort file helpers ---------------------------------------------------------------

export const dataDir = (env: Record<string, string | undefined> = process.env): string => env.TASKSHAPE_HOME || join(homedir(), '.taskshape')

export const dataPaths = (dir: string) => ({
  config: join(dir, 'copilot.json'),
  decisions: join(dir, 'decisions.jsonl'),
  outcomes: join(dir, 'outcomes.jsonl'),
  pending: join(dir, 'pending'),
  sessions: join(dir, 'sessions'),
  catalog: join(dir, 'models.json'),
  lock: join(dir, 'models.lock'),
})

export const readJson = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/** Write the default config file (and its folder) if none exists; returns whether it was written. Never throws. */
export const ensureConfig = (path: string): boolean => {
  try {
    if (existsSync(path)) return false
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, configTemplate(), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

export const appendLine = (path: string, row: unknown): void => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(row) + '\n')
  } catch {
    // the audit trail must never break the launch
  }
}

const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)

export const writeJson = (dir: string, key: string, row: unknown): void => {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${safeKey(key)}.json`), JSON.stringify(row))
  } catch {
    // best effort
  }
}

export const rememberSessionModel = (sessionsDir: string, sessionId: string, model: string): void =>
  writeJson(sessionsDir, sessionId, { model, ts: Date.now() / 1000 })

export const sessionModel = (sessionsDir: string, sessionId: string | undefined): string | undefined => {
  if (!sessionId) return undefined
  const row = readJson(join(sessionsDir, `${safeKey(sessionId)}.json`)) as { model?: unknown } | undefined
  return typeof row?.model === 'string' ? row.model : undefined
}

/** Unfinished `.tmp-*` and `.claim-*` files belong to a hook that may still be running: they go only after this long. */
const STRAY_FILE_SECONDS = 3600

/** Drop session/pending files older than `maxAgeSeconds`; never throws. */
export const pruneDir = (dir: string, maxAgeSeconds: number): void => {
  try {
    if (!existsSync(dir)) return
    const now = Date.now() / 1000
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      try {
        if (!name.endsWith('.json')) {
          if (now - statSync(path).mtimeMs / 1000 > STRAY_FILE_SECONDS) unlinkSync(path)
          continue
        }
        const row = readJson(path) as { ts?: unknown } | undefined
        if (typeof row?.ts !== 'number' || row.ts < now - maxAgeSeconds) unlinkSync(path)
      } catch {
        // gone or in use: leave it
      }
    }
  } catch {
    // best effort
  }
}

export type PendingRow = Record<string, unknown> & { ts?: number; harness?: string; tool_use_id?: string; agent_name?: string; agent_type?: string }

/** A launch awaiting its outcome ages out after this long, so an abandoned one cannot make later stops ambiguous. */
export const PENDING_TTL = 6 * 3600

/** What the SubagentStop payload can say about the finished sub-agent; each field narrows the candidates when present. */
export type StopHint = { agentId?: string; agentName?: string; agentType?: string }

/** `popPending` found nothing (`undefined`), one launch (`row`) or several it cannot tell apart (`ambiguous`, no row). */
export type PendingMatch = { row?: PendingRow; ambiguous?: boolean }

const CLAIM = '.claim-'

/**
 * One file per launch, `<session>~<launch>.json` (`~` never occurs in a safeKey): parallel launches of one session no
 * longer overwrite each other. The launch part is the VS Code `tool_use_id` when there is one. Written through a
 * temporary file so a concurrent SubagentStop never reads half a row.
 */
export const writePending = (dir: string, sessionId: string, row: PendingRow): void => {
  try {
    mkdirSync(dir, { recursive: true })
    const name = `${safeKey(sessionId)}~${safeKey(row.tool_use_id || randomUUID())}.json`
    const temp = join(dir, `${name}.tmp-${randomUUID()}`)
    writeFileSync(temp, JSON.stringify(row))
    renameSync(temp, join(dir, name))
  } catch {
    // best effort
  }
}

type PendingFile = { name: string; path: string; row: PendingRow }

const pendingFiles = (dir: string, maxAgeSeconds: number): PendingFile[] => {
  const cutoff = Date.now() / 1000 - maxAgeSeconds
  const files: PendingFile[] = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const path = join(dir, name)
      const row = readJson(path) as PendingRow | undefined
      if (!row || typeof row !== 'object') continue
      if (typeof row.ts === 'number' && row.ts < cutoff) {
        try { unlinkSync(path) } catch { /* already gone */ }
        continue
      }
      files.push({ name, path, row })
    }
  } catch {
    // no pending directory
  }
  return files.sort((a, b) => (a.row.ts ?? 0) - (b.row.ts ?? 0))
}

/** The session part of a pending file name; files written before launches got their own name are `<session>.json`. */
const pendingSession = (name: string): string => name.replace(/\.json$/, '').split('~')[0]

/** Take a launch for good: whoever renames the file owns it, a concurrent consumer that loses the rename gets nothing. */
const claim = (file: PendingFile): PendingRow | undefined => {
  const claimed = `${file.path}${CLAIM}${randomUUID()}`
  try {
    renameSync(file.path, claimed)
  } catch {
    return undefined
  }
  try { unlinkSync(claimed) } catch { /* pruned later */ }
  return file.row
}

/** Narrow by the most specific key both sides carry; a key that matches nobody is ignored rather than trusted. */
const narrow = (files: PendingFile[], hint: StopHint): PendingFile[] => {
  const steps: Array<(f: PendingFile) => boolean> = []
  if (hint.agentId) steps.push(f => f.row.tool_use_id === hint.agentId)
  if (hint.agentName) steps.push(f => f.row.agent_name === hint.agentName)
  if (hint.agentType) steps.push(f => f.row.agent_type === hint.agentType)
  let left = files
  for (const step of steps) {
    const kept = left.filter(step)
    if (kept.length === 1) return kept
    if (kept.length > 1) left = kept
  }
  return left
}

/**
 * Pop the decision awaiting an outcome. The session's own launches first; VS Code's SubagentStop may carry the sub-agent's
 * own session id, so for that harness any VS Code launch is a candidate when the session matches none. Candidates are
 * narrowed by the keys both payloads share (`tool_use_id`/`agent_id`, agent name, agent type). The result is attributed only
 * when one candidate remains. Limit: neither harness gives an id that ties a stop to its launch for sure, so identical
 * parallel launches stay ambiguous. Within a session every launch the stop could belong to is consumed and the outcome is
 * reported unassociated: leaving one behind would let a later stop of another look unique and be credited to the wrong
 * profile. Across sessions nothing is consumed, since the owner is unknown.
 */
export const popPending = (pendingDir: string, sessionId: string | undefined, harness: Harness, hint: StopHint = {},
  maxAgeSeconds = PENDING_TTL): PendingMatch | undefined => {
  const all = pendingFiles(pendingDir, maxAgeSeconds)
  const own = sessionId ? all.filter(f => pendingSession(f.name) === safeKey(sessionId)) : []
  const sameSession = own.length > 0
  if (!sameSession && harness !== 'vscode-local') return undefined
  const candidates = sameSession ? own : all.filter(f => f.row.harness === 'vscode-local')
  if (candidates.length === 0) return undefined
  const left = narrow(candidates, hint)
  if (left.length === 1) {
    const row = claim(left[0])
    return row ? { row } : undefined
  }
  if (sameSession) for (const file of left) claim(file)
  return { ambiguous: true }
}

// ---- the account's model catalog (discovered through the Copilot CLI, see discover.ts) --------------

/** What the account offers, as discovered: ids with the display name VS Code matches on and the usage multiplier. */
export type Catalog = { ts: number; source: string; models: Record<string, ModelInfo>; error?: string }

export const CATALOG_TTL = 24 * 3600 // seconds a successful discovery is trusted
export const CATALOG_RETRY = 3600 // seconds before retrying after a failed one

/**
 * Parse the ACP `session/new` result (`models.availableModels[]`, each `{ modelId, name, _meta: { copilotUsage: "0.33x",
 * copilotEnablement, copilotPriceCategory } }`). Disabled entries are skipped; `auto` keeps no multiplier because VS Code
 * applies no ceiling when the main model is Auto, whatever the CLI bills it as.
 */
export const parseAcpModels = (result: unknown): Record<string, ModelInfo> => {
  const out: Record<string, ModelInfo> = Object.create(null)
  const list = (result as { models?: { availableModels?: unknown } } | undefined)?.models?.availableModels
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    const e = entry as { modelId?: unknown; name?: unknown; _meta?: { copilotUsage?: unknown; copilotEnablement?: unknown } }
    if (typeof e.modelId !== 'string' || !e.modelId) continue
    const meta = e._meta ?? {}
    if (typeof meta.copilotEnablement === 'string' && meta.copilotEnablement !== 'enabled') continue
    const info: ModelInfo = { ...ownInfo(out, e.modelId) }
    if (typeof e.name === 'string' && e.name) info.name = e.name
    const usage = typeof meta.copilotUsage === 'string' ? Number.parseFloat(meta.copilotUsage) : typeof meta.copilotUsage === 'number' ? meta.copilotUsage : Number.NaN
    if (e.modelId !== 'auto' && Number.isFinite(usage) && usage >= 0) info.multiplier = usage
    out[e.modelId] = info
  }
  return out
}

export const catalogFresh = (catalog: Catalog | undefined, now = Date.now() / 1000): boolean => {
  if (!catalog || typeof catalog.ts !== 'number') return false
  return now - catalog.ts < (catalog.error ? CATALOG_RETRY : CATALOG_TTL)
}

/**
 * Restrict the table to what the account offers: discovered names and multipliers win over the shipped `models` map and
 * profiles whose model is not offered are dropped (they would fail the launch). A catalog without models, or one that
 * would drop every profile, leaves the table unchanged.
 */
export const applyCatalog = (table: Table, catalog: Catalog | undefined): { table: Table; dropped: string[]; warning?: string } => {
  if (!catalog || !catalog.models || Object.keys(catalog.models).length === 0) return { table, dropped: [] }
  const models: Record<string, ModelInfo> = Object.create(null)
  for (const [id, info] of Object.entries(table.models)) models[id] = info
  for (const [id, info] of Object.entries(catalog.models)) models[id] = { ...ownInfo(models, id), ...info }
  const offered = (model: string): boolean => Object.hasOwn(catalog.models, model)
  const profiles = table.profiles.filter(p => offered(p.model))
  if (profiles.length === 0) {
    return { table: { ...table, models }, dropped: [], warning: 'no profile names a model the account offers; routing over the whole table' }
  }
  const dropped = table.profiles.filter(p => !offered(p.model)).map(p => p.id)
  return { table: { ...table, models, profiles }, dropped }
}

export const readCatalog = (path: string): Catalog | undefined => {
  const value = readJson(path) as Catalog | undefined
  return value && typeof value === 'object' && value.models && typeof value.models === 'object' ? value : undefined
}

export const writeCatalog = (path: string, catalog: Catalog): void => {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n')
  } catch {
    // best effort
  }
}

/** A lock file so concurrent hooks (several VS Code sessions starting at once) run one discovery; stale after 60 s. */
export const acquireLock = (path: string, staleSeconds = 60): boolean => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, String(process.pid), { flag: 'wx' })
      return true
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > staleSeconds * 1000) unlinkSync(path)
        else return false
      } catch {
        return false
      }
    }
  }
  return false
}

export const releaseLock = (path: string): void => {
  try { unlinkSync(path) } catch { /* already gone */ }
}
