// Run: node --experimental-strip-types --test plugins/shared/rubric.test.ts
// Mirrors the rubric regressions in tests/test_core_audit.py so the TypeScript port and the Python rubric stay in step.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from './rubric.ts'

test('broad cues do not make unrelated words coupled', () => {
  for (const text of ['Author the changelog entry', 'Update the lockfile', 'Save the report as markdown']) {
    assert.notEqual(classify(text), 'coupled', text)
  }
})

test('real cues still make coupled', () => {
  for (const text of ['Fix the authentication flow', 'Check authorization for the admin route', 'The job locks the table', 'Fix the auth bug',
    'Fix OAuth login redirect', 'Fix the unauthorized 401 error', 'OAuth2 flow', 'authn token refresh', 'Review authz rules',
    'Fix the unauthenticated path', 'Handle authorisation errors']) {
    assert.equal(classify(text), 'coupled', text)
  }
})

test('source and bare see do not erase the rest of the clause', () => {
  assert.equal(classify('Look at the source and fix the race condition'), 'coupled')
  assert.equal(classify('Check the following and fix the deadlock'), 'coupled')
})

test('real citations and negations are still stripped', () => {
  assert.equal(classify('Fix the label contrast; applies RFC-7 and the save-format spec; docs-only'), 'routine')
  assert.equal(classify('Fix the label; per the migration guide section 3'), 'routine')
  assert.equal(classify('Fix the label; see the schema doc'), 'routine')
  assert.equal(classify('Fix the label; conforms to RFC-7231 and §4.2'), 'routine')
  assert.equal(classify('Rename the config keys; no schema changes; persistence untouched'), 'routine')
})

test('a citation removes only the reference, not the rest of the sentence', () => {
  for (const text of ['Per the ticket fix the deadlock', 'See the spec and fix the race condition',
    'Implement per the RFC-7 the schema migration', 'Applies RFC-7 but the migration must be idempotent']) {
    assert.equal(classify(text), 'coupled', text)
  }
  assert.equal(classify('Author the changelog entry'), 'routine')
})
