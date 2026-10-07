// The policy table, a port of src/taskshape/policy.py, plus the built-in profiles that make the plugin
// work with no configuration in Claude Code. Claude Code's Agent tool takes a model alias and no effort
// field, so built-in profiles carry an alias; a profiles.json from the Python side carries model ids.
import { type Phase, type Shape, SHAPES } from './shapes.ts'

export type Profile = {
  id: string
  model: string
  effort?: string
  capability: number
  cost_tier: number
  phases?: readonly Phase[]
  vision?: boolean
}

export type Budgets = Record<string, { max_cost_tier: number }>

/** Optional per-model facts a harness needs: the display name VS Code matches on, and the usage multiplier it compares. */
export type ModelInfo = { name?: string; multiplier?: number }

export type Table = { profiles: Profile[]; budgets: Budgets; models: Record<string, ModelInfo> }

export type Choice = { profile: Profile; reason: string; warnings: string[]; considered: string[] }

// Capability: 0 mechanical, 1 routine, 2 demanding, 3 coupled/review, 4 frontier. Cost tiers order by expected cost per task.
export const DEFAULT_PROFILES: Profile[] = [
  { id: 'haiku', model: 'claude-haiku-4-5', capability: 1, cost_tier: 0, phases: ['work'], vision: true },
  { id: 'sonnet', model: 'claude-sonnet-5-5', capability: 2, cost_tier: 1, phases: ['work'], vision: true },
  { id: 'opus', model: 'claude-opus-5-5', capability: 4, cost_tier: 3, phases: ['work', 'review'], vision: true },
]
export const DEFAULT_BUDGETS: Budgets = { economy: { max_cost_tier: 1 }, standard: { max_cost_tier: 3 }, default: { max_cost_tier: 5 } }

export const validateProfiles = (value: unknown): Table => {
  const v = value as { version?: unknown; profiles?: unknown; budgets?: unknown; models?: unknown }
  if (!v || typeof v !== 'object' || v.version !== 1 || !Array.isArray(v.profiles) || v.profiles.length === 0) {
    throw new Error('profiles.json needs version 1 and a non-empty profiles list')
  }
  const seen = new Set<string>()
  const profiles = v.profiles.map((p: Record<string, unknown>) => {
    for (const key of ['id', 'model', 'capability', 'cost_tier']) if (!(key in p)) throw new Error(`profile lacks ${key}`)
    const id = String(p.id)
    if (seen.has(id)) throw new Error(`duplicate profile id ${id}`)
    seen.add(id)
    const capability = Number(p.capability)
    const cost = Number(p.cost_tier)
    if (!Number.isInteger(capability) || capability < 0 || capability > 4) throw new Error(`capability out of range: ${id}`)
    if (!Number.isInteger(cost) || cost < 0 || cost > 5) throw new Error(`cost_tier out of range: ${id}`)
    const phases = (Array.isArray(p.phases) && p.phases.length ? p.phases : ['work', 'review']) as Phase[]
    if (phases.some(ph => ph !== 'work' && ph !== 'review')) throw new Error(`bad phases: ${id}`)
    return { id, model: String(p.model), effort: p.effort === undefined ? undefined : String(p.effort), capability, cost_tier: cost,
      phases, vision: p.vision === true }
  })
  const budgets = (v.budgets && typeof v.budgets === 'object' ? v.budgets : { default: { max_cost_tier: 5 } }) as Budgets
  for (const [name, b] of Object.entries(budgets)) {
    if (!b || !Number.isInteger(b.max_cost_tier) || b.max_cost_tier < 0 || b.max_cost_tier > 5) throw new Error(`bad budget ${name}`)
  }
  const models: Record<string, ModelInfo> = {}
  if (v.models !== undefined) {
    if (!v.models || typeof v.models !== 'object' || Array.isArray(v.models)) throw new Error('models must be an object keyed by model id')
    for (const [id, raw] of Object.entries(v.models as Record<string, unknown>)) {
      const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const info: ModelInfo = {}
      if (m.name !== undefined) {
        if (typeof m.name !== 'string' || !m.name.trim()) throw new Error(`models.${id}.name must be a non-empty string`)
        info.name = m.name.trim()
      }
      if (m.multiplier !== undefined) {
        const n = Number(m.multiplier)
        if (!Number.isFinite(n) || n < 0) throw new Error(`models.${id}.multiplier must be a non-negative number`)
        info.multiplier = n
      }
      models[id] = info
    }
  }
  return { profiles, budgets, models }
}

export const choose = (shape: Shape, profiles: readonly Profile[], phase: Phase = 'work', maxCostTier = 5): Choice => {
  const required = SHAPES[shape].capability
  const needs = SHAPES[shape].needs ?? []
  const candidates = profiles.filter(p => (p.phases ?? ['work', 'review']).includes(phase) && needs.every(flag => flag === 'vision' ? p.vision === true : false))
  if (candidates.length === 0) throw new Error(`no profile is eligible for phase ${phase} and shape ${shape}`)
  const within = candidates.filter(p => p.cost_tier <= maxCostTier)
  if (within.length === 0) throw new Error(`no eligible profile fits max_cost_tier=${maxCostTier}`)
  const order = (a: Profile, b: Profile) => a.cost_tier - b.cost_tier || b.capability - a.capability || a.id.localeCompare(b.id)
  const considered = [...within].sort(order).map(p => p.id)
  const adequate = within.filter(p => p.capability >= required).sort(order)
  if (adequate.length > 0) {
    const pick = adequate[0]
    return { profile: pick, reason: `cheapest profile whose capability ${pick.capability} covers ${shape} (needs ${required})`, warnings: [], considered }
  }
  const pick = [...within].sort((a, b) => b.capability - a.capability || a.cost_tier - b.cost_tier || a.id.localeCompare(b.id))[0]
  return { profile: pick, reason: `most capable profile within the budget; none reaches capability ${required}`,
    warnings: [`under-provisioned: ${shape} needs capability ${required}, ${pick.id} has ${pick.capability}`], considered }
}
