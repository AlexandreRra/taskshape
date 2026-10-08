// Run: node --experimental-strip-types --test plugins/shared/policy.test.ts
// Mirrors the policy and profile-validation regressions in tests/test_core_audit.py.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Profile, choose, validateProfiles } from './policy.ts'

const profile = (id: string, capability: number, cost_tier: number): Profile => ({ id, model: 'm', effort: 'high', capability, cost_tier })

test('under-provisioned ties break by capability, then cost, then lowest id', () => {
  const tie = choose('architecture', [profile('b-high', 2, 1), profile('a-high', 2, 1)])
  assert.equal(tie.profile.id, 'a-high')
  assert.ok(tie.warnings[0].includes('under-provisioned'))
  assert.equal(choose('architecture', [profile('a', 2, 2), profile('z', 2, 1)]).profile.id, 'z')
  assert.equal(choose('architecture', [profile('a', 1, 0), profile('z', 2, 3)]).profile.id, 'z')
})

test('ids compare by code point like Python, not by locale', () => {
  assert.equal(choose('architecture', [profile('a', 2, 1), profile('B', 2, 1)]).profile.id, 'B')
})

const wrap = (p: Record<string, unknown>) => ({ version: 1, profiles: [{ id: 'a', model: 'm', capability: 1, cost_tier: 1, ...p }] })

test('numeric profile fields refuse booleans and strings', () => {
  assert.equal(validateProfiles(wrap({})).profiles[0].capability, 1)
  for (const bad of [true, false, '2', null, 2.5, NaN, Infinity]) {
    assert.throws(() => validateProfiles(wrap({ capability: bad })), /capability out of range/, String(bad))
    assert.throws(() => validateProfiles(wrap({ cost_tier: bad })), /cost_tier out of range/, String(bad))
  }
})

test('effort is optional and defaults like the Python loader', () => {
  assert.equal(validateProfiles(wrap({})).profiles[0].effort, 'default')
  assert.equal(validateProfiles(wrap({ effort: 'high' })).profiles[0].effort, 'high')
  for (const bad of [null, 5, '', true]) assert.throws(() => validateProfiles(wrap({ effort: bad })), /effort must be/, String(bad))
})

test('file-supplied names such as __proto__, constructor and toString are plain keys, never inherited', () => {
  const text = '{"version": 1, "profiles": [{"id": "a", "model": "m", "capability": 1, "cost_tier": 1}],'
    + ' "budgets": {"__proto__": {"max_cost_tier": 2}, "default": {"max_cost_tier": 5}},'
    + ' "models": {"__proto__": {"multiplier": 3}, "m": {"name": "M"}}}'
  const table = validateProfiles(JSON.parse(text))
  for (const map of [table.models, table.budgets]) {
    assert.equal(Object.getPrototypeOf(map), null)
    assert.equal(Object.getPrototypeOf({}), Object.prototype)
    assert.equal(Object.hasOwn(map, '__proto__'), true)
    for (const absent of ['constructor', 'toString']) {
      assert.equal(Object.hasOwn(map, absent), false, absent)
      assert.equal(map[absent], undefined, absent)
    }
  }
  assert.equal(table.models['__proto__'].multiplier, 3)
  assert.equal(table.budgets['__proto__'].max_cost_tier, 2)
  assert.equal(table.models.m.name, 'M')
  const bare = validateProfiles({ version: 1, profiles: [{ id: 'a', model: 'm', capability: 1, cost_tier: 1 }] })
  assert.equal(bare.budgets.default.max_cost_tier, 5)
  assert.equal(Object.hasOwn(bare.budgets, 'constructor'), false)
  assert.equal(Object.hasOwn(bare.models, 'toString'), false)
})

test('profile keys are read as own properties only', () => {
  const inherited = Object.create({ capability: 1, cost_tier: 1 })
  Object.assign(inherited, { id: 'a', model: 'm' })
  assert.throws(() => validateProfiles({ version: 1, profiles: [inherited] }), /lacks capability/)
})
