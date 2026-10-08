import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadArtifact, validateClassification } from './runtime.ts'

const probability = { lookup: 0.1, routine: 0.1, demanding: 0.1, visual: 0.1, coupled: 0.5, architecture: 0.1 }
test('a typed local answer must cover every offered option with a finite distribution', () => {
  const answer = { shape: 'coupled', answer_confidence: 0.5, shape_probabilities: probability, source: 'laya' }
  assert.equal(validateClassification(answer).shape, 'coupled')
  for (const invalid of [
    { ...answer, source: 'heuristic' }, { ...answer, shape: 'review' }, { ...answer, answer_confidence: NaN },
    { ...answer, shape_probabilities: { ...probability, coupled: 1.4 } },
    { ...answer, shape_probabilities: { ...probability, routine: 0.6, coupled: 0 } },
    { ...answer, shape_probabilities: { coupled: 1 } },
  ]) assert.throws(() => validateClassification(invalid))
})

test('a verified download is atomic, reusable offline and never replaced by incorrect bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), "Taskshape O'Brien ü %23 # "))
  const file = join(dir, 'model')
  const bytes = Buffer.from('verified model content')
  const artifact = { url: 'https://example.invalid/pinned-model', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  let requests = 0
  const request = async () => { requests++; return new Response(bytes) }
  try {
    await downloadArtifact(artifact, file, request as typeof fetch)
    assert.deepEqual(readFileSync(file), bytes)
    await downloadArtifact(artifact, file, request as typeof fetch)
    assert.equal(requests, 1)
    const other = { ...artifact, sha256: '0'.repeat(64) }
    await assert.rejects(downloadArtifact(other, file, request as typeof fetch), /integrity/)
    assert.deepEqual(readFileSync(file), bytes)
    assert.deepEqual(readdirSync(dir), ['model'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unverified, insecure or oversized downloads cannot create a usable artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskshape-download-'))
  const file = join(dir, 'executable')
  const bytes = Buffer.from('too large')
  const artifact = { url: 'https://example.invalid/pinned', sha256: createHash('sha256').update(bytes).digest('hex'), size: 2 }
  try {
    await assert.rejects(downloadArtifact(artifact, file, (async () => new Response(bytes)) as typeof fetch), /larger/)
    assert.deepEqual(readdirSync(dir), [])
    await assert.rejects(downloadArtifact({ ...artifact, url: 'http://example.invalid' }, file), /Invalid/)
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
