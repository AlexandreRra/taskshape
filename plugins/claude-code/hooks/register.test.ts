import { describe, expect, test } from 'claude-code/testing'
import { aliasFor } from './register'

type Written = { path: string; text: string }

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const cliDecision = (model: string) => JSON.stringify({
  task: 'x', phase: 'work', shape: 'coupled', profile: 'sol61-high', model, effort: 'high', reason: 'cheapest adequate',
  source: 'laya', answer_confidence: 0.82, warnings: [],
})

const coupled = { tool: 'Agent' as const, description: 'ledger migration', prompt: 'Own ledger.py and tests; the migration must be idempotent' }
const typo = { tool: 'Agent' as const, description: 'typo', prompt: 'Fix the typo in README and bump the version' }

// A file system that remembers what the plugin wrote, and an environment with a home directory.
const wire = (on: any, files: Record<string, string>, writes: Written[], env: Record<string, string> = { HOME: '/home/t' }) => {
  on('env.get', (_: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { files[e.path] = e.text; writes.push({ path: e.path, text: e.text }); return { value: undefined } })
}

describe('aliasFor', () => {
  test('maps Claude ids to the Agent tool aliases and nothing else', () => {
    expect(aliasFor('claude-opus-5-5')).toBe('opus')
    expect(aliasFor('claude-sonnet-5-5')).toBe('sonnet')
    expect(aliasFor('claude-haiku-4-5')).toBe('haiku')
    expect(aliasFor('claude-fable-5-1')).toBe('fable')
    expect(aliasFor('gpt-6.1-sol')).toBeUndefined()
  })
})

describe('zero configuration', () => {
  test('suggest mode with built-in profiles logs the decision under ~/.taskshape and launches unchanged', { options: { mode: 'suggest' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    const seen: unknown[] = []
    wire(on, files, writes)
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual([undefined])
    expect(writes.map(w => w.path)).toEqual(['/home/t/.taskshape/decisions.jsonl', '/home/t/.taskshape/outcomes.jsonl'])
    const decision = JSON.parse(writes[0].text.trim())
    expect(decision.shape).toBe('coupled')
    expect(decision.profile).toBe('opus')
    expect(decision.mode).toBe('suggested')
    expect(decision.source).toBe('rubric')
    const outcome = JSON.parse(writes[1].text.trim())
    expect(outcome.accepted).toBe(true)
    expect(outcome.model).toBe('inherited')
    // a second decision appends rather than overwrites
    await $.tool.call(typo)
    expect(files['/home/t/.taskshape/decisions.jsonl'].trim().split('\n').length).toBe(2)
  })

  test('with no options at all it enforces: the model is rewritten to the built-in profile alias per shape', async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    const seen: unknown[] = []
    wire(on, files, writes)
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    await $.tool.call(typo)
    expect(seen).toEqual(['opus', 'haiku'])
    const outcome = JSON.parse(files['/home/t/.taskshape/outcomes.jsonl'].trim().split('\n')[0])
    expect(outcome.model).toBe('claude-opus-5-5')
    expect(outcome.outcome).toBe('enforced')
  })

  test('CLAUDE_PLUGIN_DATA wins over the home folder', { options: { mode: 'suggest' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    wire(on, files, writes, { HOME: '/home/t', CLAUDE_PLUGIN_DATA: '/data/taskshape' })
    on('tool.call', { tool: 'Agent' }, () => ({ result: 'done', text: 'done' }))
    await $.tool.call(typo)
    expect(writes[0].path).toBe('/data/taskshape/decisions.jsonl')
  })

  test('keeps an explicit model and a fork unchanged', { options: { mode: 'enforce' } }, async ($, on) => {
    const seen: unknown[] = []
    wire(on, {}, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { subagent_type?: string; model?: string }) => { seen.push([e.subagent_type, e.model]); return { result: 'done', text: 'done' } })
    await $.tool.call({ ...coupled, model: 'haiku' })
    await $.tool.call({ ...coupled, subagent_type: 'fork' })
    expect(seen).toEqual([[undefined, 'haiku'], ['fork', undefined]])
  })
})

describe('profiles file', () => {
  test('a valid profiles.json replaces the built-in table', { options: { mode: 'enforce', profiles: '/etc/p.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/p.json': JSON.stringify({ version: 1, profiles: [
      { id: 'only-sonnet', model: 'claude-sonnet-5-5', capability: 4, cost_tier: 1, phases: ['work', 'review'] }] }) }
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual(['sonnet'])
    expect(JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim()).profile).toBe('only-sonnet')
  })

  test('an unreadable or invalid profiles.json falls back to the built-in table with a warning', { options: { mode: 'enforce', profiles: '/etc/bad.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/bad.json': '{"version": 2}' }
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual(['opus'])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.warnings.join(' ')).toContain('built-in profiles used')
  })
})

describe('python command', () => {
  test('uses the CLI decision when a command is configured', { options: { mode: 'enforce', command: '/opt/taskshape', profiles: '/etc/p.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/p.json': JSON.stringify({ version: 1, profiles: [{ id: 'sol61-high', model: 'gpt-6.1-sol', capability: 3, cost_tier: 3 }] }) }
    const argvs: string[][] = []
    const seen: unknown[] = []
    wire(on, files, [])
    on('process.run', (_: unknown, e: { argv: readonly string[] }) => { argvs.push([...e.argv]); return ok(cliDecision('claude-opus-5-5')) })
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual(['opus'])
    expect(argvs.length).toBe(1)
    expect(argvs[0].slice(0, 2)).toEqual(['/opt/taskshape', 'route'])
    expect(argvs[0]).toContain('/etc/p.json')
    expect(JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim()).source).toBe('cli:laya')
  })

  test('a non-Claude profile from the CLI is reported and the launch stays unchanged', { options: { mode: 'enforce', command: '/opt/taskshape' } }, async ($, on) => {
    const seen: unknown[] = []
    wire(on, {}, [])
    on('process.run', () => ok(cliDecision('gpt-6.1-sol')))
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual([undefined])
  })

  test('a failing CLI falls back to the built-in rubric and says so', { options: { mode: 'enforce', command: '/opt/taskshape' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const seen: unknown[] = []
    wire(on, files, [])
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'ValueError: boom', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual(['opus'])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.source).toBe('rubric-fallback')
    expect(decision.warnings.join(' ')).toContain('taskshape command failed')
  })
})
