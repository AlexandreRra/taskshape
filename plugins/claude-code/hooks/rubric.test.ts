import { describe, expect, test } from 'claude-code/testing'
import { classify } from './rubric.ts'
import { DEFAULT_BUDGETS, DEFAULT_PROFILES, choose, validateProfiles } from './policy.ts'

// Mirrors tests/test_core.py so the TypeScript port and the Python rubric stay in step.
describe('rubric', () => {
  test('shapes from cues and roles', () => {
    const cases: Array<['work' | 'review', string | undefined, string, string]> = [
      ['work', undefined, 'Fix the typo in README and bump the version', 'routine'],
      ['work', undefined, 'Own ledger.py and tests; keep the v3 ledger format readable; the migration must be idempotent', 'coupled'],
      ['work', undefined, 'Implement the export feature; cause of the slow upload not yet confirmed; reproduce first, several steps', 'demanding'],
      ['work', undefined, 'Write the ADR for the queue redesign; weigh tradeoffs; no code', 'architecture'],
      ['work', undefined, 'Review the screenshot of the settings page against the mockup and list visual defects', 'visual'],
      ['work', undefined, "Find the exact string 'retry-after' in the client package", 'lookup'],
      ['work', 'debugger', 'Why does the nightly job fail?', 'coupled'],
      ['work', 'explore', 'Where does the HUD get its scale? list files', 'routine'],
      ['review', 'code-reviewer', 'Read-only review of the label diff; no edits', 'review'],
      ['review', undefined, 'Challenge the proposed architecture for the cache layer; tradeoffs', 'architecture'],
      ['work', undefined, 'Third attempt after two failed repairs; escalate and reassess the design', 'architecture'],
    ]
    for (const [phase, role, text, expected] of cases) expect(classify(text, phase, role)).toBe(expected)
  })

  test('citations and negations do not escalate', () => {
    expect(classify('Fix the label contrast; applies RFC-7 and the save-format spec; docs-only')).toBe('routine')
    expect(classify('Rename the config keys; no schema changes; persistence untouched')).toBe('routine')
    expect(classify('Wording fix; do not escalate; according to the migration guide section 3')).toBe('routine')
  })
})

describe('policy', () => {
  test('built-in Claude profiles pick the cheapest adequate alias and cap by budget', () => {
    expect(choose('lookup', DEFAULT_PROFILES).profile.id).toBe('haiku')
    expect(choose('routine', DEFAULT_PROFILES).profile.id).toBe('haiku')
    expect(choose('demanding', DEFAULT_PROFILES).profile.id).toBe('sonnet')
    expect(choose('visual', DEFAULT_PROFILES).profile.id).toBe('sonnet')
    expect(choose('coupled', DEFAULT_PROFILES).profile.id).toBe('opus')
    expect(choose('architecture', DEFAULT_PROFILES).profile.id).toBe('opus')
    expect(choose('review', DEFAULT_PROFILES, 'review').profile.id).toBe('opus')
    const capped = choose('coupled', DEFAULT_PROFILES, 'work', DEFAULT_BUDGETS.economy.max_cost_tier)
    expect(capped.profile.id).toBe('sonnet')
    expect(capped.warnings[0]).toContain('under-provisioned')
    expect(() => choose('routine', DEFAULT_PROFILES, 'review', 0)).toThrow()
  })

  test('profiles.json validation mirrors the Python loader', () => {
    const good = { version: 1, profiles: [{ id: 'a', model: 'claude-opus-5-5', capability: 4, cost_tier: 3 }], budgets: { default: { max_cost_tier: 5 } } }
    expect(validateProfiles(good).profiles[0].phases).toEqual(['work', 'review'])
    expect(() => validateProfiles({ version: 1, profiles: [] })).toThrow()
    expect(() => validateProfiles({ version: 1, profiles: [{ id: 'a', model: 'm', capability: 9, cost_tier: 1 }] })).toThrow()
    expect(() => validateProfiles({ version: 1, profiles: [{ id: 'a', model: 'm', capability: 1, cost_tier: 1 }, { id: 'a', model: 'm', capability: 1, cost_tier: 1 }] })).toThrow()
    expect(() => validateProfiles({ version: 1, profiles: [{ id: 'a', model: 'm', capability: 1, cost_tier: 1, phases: ['deploy'] }] })).toThrow()
  })
})
