import type { EngineInterface, Register } from 'claude-code'
import { classify } from './rubric.ts'
import { type Budgets, type Profile, DEFAULT_BUDGETS, DEFAULT_PROFILES, choose, validateProfiles } from './policy.ts'
import type { Phase, Shape } from './shapes.ts'

// Claude Code's Agent tool takes a model alias, not a full id, and no effort field.
type Alias = 'sonnet' | 'opus' | 'haiku' | 'fable'

export type Decision = {
  task: string
  phase: Phase
  shape: Shape
  profile: string
  model: string
  effort: string
  reason: string
  source: string
  answer_confidence: number
  warnings: string[]
}

type Loaded = { profiles: Profile[]; budgets: Budgets; source: string; warning?: string }

const RUBRIC_CONFIDENCE = 0.7
const BUILTIN: Loaded = { profiles: DEFAULT_PROFILES, budgets: DEFAULT_BUDGETS, source: 'built-in' }

// Module-level caches: a reload of the module starts them over, which is what a config change wants.
let loadedProfiles: Promise<Loaded> | undefined
let dataFolder: Promise<string> | undefined

export const aliasFor = (model: string): Alias | undefined => {
  const id = model.toLowerCase()
  if (id.includes('fable') || id.includes('mythos')) return 'fable'
  if (id.includes('opus')) return 'opus'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('haiku')) return 'haiku'
  return undefined
}

export const routeEmbedded = (task: string, phase: Phase, loaded: Loaded, budget: string): Decision => {
  const cap = loaded.budgets[budget]?.max_cost_tier ?? loaded.budgets.default?.max_cost_tier ?? 5
  const shape = classify(task, phase)
  const choice = choose(shape, loaded.profiles, phase, cap)
  const warnings = [...choice.warnings]
  if (loaded.warning) warnings.push(loaded.warning)
  return { task: task.slice(0, 500), phase, shape, profile: choice.profile.id, model: choice.profile.model,
    effort: choice.profile.effort ?? 'default', reason: choice.reason, source: 'rubric', answer_confidence: RUBRIC_CONFIDENCE, warnings }
}

async function loadProfiles($: EngineInterface, profilesPath: string): Promise<Loaded> {
  if (!profilesPath) return BUILTIN
  loadedProfiles ??= (async () => {
    try {
      const parsed = validateProfiles(JSON.parse(String(await $.fs.read(profilesPath))))
      return { ...parsed, source: profilesPath }
    } catch (error) {
      return { ...BUILTIN, warning: `profiles file unusable, built-in profiles used: ${String(error).slice(0, 120)}` }
    }
  })()
  return loadedProfiles
}

async function dataDir($: EngineInterface): Promise<string> {
  dataFolder ??= (async () => {
    const explicit = await $.env.get('CLAUDE_PLUGIN_DATA')
    if (explicit) return explicit
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '.'
    return `${home}/.taskshape`
  })()
  return dataFolder
}

async function appendLine($: EngineInterface, path: string, row: unknown): Promise<void> {
  try {
    const existing = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    await $.fs.write(path, existing + JSON.stringify(row) + '\n')
  } catch {
    // The audit trail is best effort; a full disk or a read-only folder must not touch the launch.
  }
}

async function routeCli($: EngineInterface, command: string, task: string, phase: Phase, loaded: Loaded, budget: string,
  profilesPath: string, config: string): Promise<Decision> {
  const argv = [command, 'route', '--budget', budget, '--phase', phase, '--task', task, '--origin', 'claude-code-plugin',
    '--profiles', profilesPath || `${$.plugin.root}/profiles.builtin.json`]
  if (config) argv.push('--config', config)
  const ran = await $.process.run(argv, { timeoutMs: 30000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().slice(0, 200) || `exit ${ran.exitCode}`)
  const parsed = JSON.parse(ran.stdout) as Decision
  parsed.source = `cli:${parsed.source}`
  if (loaded.warning) parsed.warnings = [...(parsed.warnings ?? []), loaded.warning]
  return parsed
}

export const register: Register = (on, options) => {
  const command = String(options.command || '')
  const profilesPath = String(options.profiles || '')
  const budget = String(options.budget || 'default')
  const config = String(options.config || '')
  const decisionsOption = String(options.decisions || '')
  const recordsOption = String(options.records || '')
  const enforce = options.mode !== 'suggest' // routing is on unless the user asks to only observe
  const respectExplicit = options.respectExplicitModel !== false
  loadedProfiles = undefined
  dataFolder = undefined

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const name = $.plugin.name
    if (e.subagent_type === 'fork') return next(e) // forks always inherit the parent model
    if (respectExplicit && e.model) {
      $.ui.status(`${name}: explicit model ${e.model} kept`)
      return next(e)
    }
    const phase: Phase = 'work'
    const loaded = await loadProfiles($, profilesPath)
    let decision: Decision
    try {
      decision = command ? await routeCli($, command, e.prompt, phase, loaded, budget, profilesPath, config)
        : routeEmbedded(e.prompt, phase, loaded, budget)
    } catch (error) {
      // The Python router failed: the built-in rubric answers instead, and the decision says so.
      try {
        decision = routeEmbedded(e.prompt, phase, loaded, budget)
        decision.source = 'rubric-fallback'
        decision.warnings.push(`taskshape command failed: ${String(error).slice(0, 120)}`)
      } catch (inner) {
        $.ui.status(`${name}: routing failed, launch unchanged (${String(inner).slice(0, 80)})`)
        return next(e)
      }
    }
    const folder = await dataDir($)
    const decisionsPath = decisionsOption || `${folder}/decisions.jsonl`
    const recordsPath = recordsOption || `${folder}/outcomes.jsonl`
    const alias = aliasFor(decision.model)
    const apply = enforce && alias !== undefined
    const effort = decision.effort && decision.effort !== 'default' ? ' ' + decision.effort : ''
    $.ui.status(`${name}: ${apply ? 'enforced' : 'suggested'} ${decision.shape} -> ${decision.profile} (${decision.model}${effort}, ${decision.source})`)
    if (enforce && alias === undefined) $.ui.toast(`${name}: ${decision.model} is not a Claude Code model alias; launch unchanged`)
    await appendLine($, decisionsPath, { ts: Date.now() / 1000, origin: 'claude-code-plugin', mode: apply ? 'enforced' : 'suggested',
      phase, shape: decision.shape, profile: decision.profile, model: decision.model, effort: decision.effort,
      answer_confidence: decision.answer_confidence, source: decision.source, reason: decision.reason, warnings: decision.warnings,
      subagent_type: e.subagent_type ?? null, description: e.description })
    const started = Date.now()
    const ran = await next(apply ? { ...e, model: alias } : e)
    if (ran.deny === undefined) {
      await appendLine($, recordsPath, { ts: Date.now() / 1000, task_sha256: null, shape: decision.shape, profile: decision.profile,
        model: apply ? decision.model : (e.model ?? 'inherited'), effort: apply ? decision.effort : 'default',
        accepted: ran.isError !== true, outcome: apply ? 'enforced' : 'suggested', input_tokens: null, output_tokens: null,
        seconds: Math.round((Date.now() - started) / 100) / 10, cost_usd: null })
    }
    return ran
  })
}
