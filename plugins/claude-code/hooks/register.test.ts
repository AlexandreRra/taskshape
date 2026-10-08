import { describe, expect, test } from 'claude-code/testing'
import { aliasFor } from './register.ts'

type Written = { path: string; text: string }

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const cliDecision = (model: string) => JSON.stringify({
  task: 'x', phase: 'work', shape: 'coupled', profile: 'sol61-high', model, effort: 'high', reason: 'cheapest adequate',
  source: 'laya', answer_confidence: 0.82, warnings: [],
})
const layaDecision = (shape = 'coupled') => JSON.stringify({ shape, answer_confidence: 0.91, source: 'laya' })

const coupled = { tool: 'Agent' as const, description: 'ledger migration', prompt: 'Own ledger.py and tests; the migration must be idempotent' }
const typo = { tool: 'Agent' as const, description: 'typo', prompt: 'Fix the typo in README and bump the version' }
const privateSuggest = {
  tool: 'Agent' as const,
  description: 'PRIVATE_SUGGEST_DESCRIPTION_do_not_persist_b42a7d',
  prompt: 'PRIVATE_SUGGEST_PROMPT_do_not_persist_a93f21 Own billing ledger and tests; migration must be idempotent',
}
const privateEnforce = {
  tool: 'Agent' as const,
  description: 'PRIVATE_ENFORCE_DESCRIPTION_do_not_persist_f71c20',
  prompt: 'PRIVATE_ENFORCE_PROMPT_do_not_persist_c84e31 Own auth migration and tests; migration must be idempotent',
}

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

const persistedText = (files: Record<string, string>, writes: Written[]) =>
  Object.values(files).join('\n') + '\n' + writes.map(w => w.text).join('\n')

const expectNoRawTaskText = (files: Record<string, string>, writes: Written[], task: { description: string; prompt: string }) => {
  const text = persistedText(files, writes)
  expect(text).not.toContain(task.description)
  expect(text).not.toContain(task.prompt)
  expect(text).not.toContain('"description"')
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
  test('suggest mode with built-in profiles logs the decision under ~/.taskshape and launches unchanged', { options: { mode: 'suggest', backend: 'heuristic' } }, async ($, on) => {
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
    expect('description' in decision).toBe(false)
    expect(files['/home/t/.taskshape/decisions.jsonl']).not.toContain(coupled.description)
    expect(files['/home/t/.taskshape/decisions.jsonl']).not.toContain(coupled.prompt)
    const outcome = JSON.parse(writes[1].text.trim())
    expect(outcome.accepted).toBe(true)
    expect(outcome.model).toBe('inherited')
    // nothing ran under the suggested profile, so no report may credit it
    expect(outcome.profile).toBe(null)
    expect(outcome.suggested_profile).toBe('opus')
    // a second decision appends rather than overwrites
    await $.tool.call(typo)
    expect(files['/home/t/.taskshape/decisions.jsonl'].trim().split('\n').length).toBe(2)
  })

  test('with heuristic backend it enforces: the model is rewritten to the built-in profile alias per shape', { options: { backend: 'heuristic' } }, async ($, on) => {
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
    expect(outcome.profile).toBe('opus')
    expect(outcome.suggested_profile).toBe(null)
  })

  test('suggest mode keeps private task text in the launch but out of decisions and outcomes', { options: { mode: 'suggest', backend: 'heuristic' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    const seen: unknown[] = []
    wire(on, files, writes)
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { description?: string; prompt?: string; model?: string }) => {
      seen.push({ description: e.description, prompt: e.prompt, model: e.model })
      return { result: 'done', text: 'done' }
    })
    await $.tool.call(privateSuggest)
    expect(seen).toEqual([{ description: privateSuggest.description, prompt: privateSuggest.prompt, model: undefined }])
    expect(writes.map(w => w.path)).toEqual(['/home/t/.taskshape/decisions.jsonl', '/home/t/.taskshape/outcomes.jsonl'])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.mode).toBe('suggested')
    expect(decision.shape).toBe('coupled')
    expect(decision.profile).toBe('opus')
    expect('description' in decision).toBe(false)
    const outcome = JSON.parse(files['/home/t/.taskshape/outcomes.jsonl'].trim())
    expect(outcome.outcome).toBe('suggested')
    expect(outcome.model).toBe('inherited')
    expectNoRawTaskText(files, writes, privateSuggest)
  })

  test('enforce mode keeps private task text in the launch but out of decisions and outcomes', { options: { backend: 'heuristic' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    const seen: unknown[] = []
    wire(on, files, writes)
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { description?: string; prompt?: string; model?: string }) => {
      seen.push({ description: e.description, prompt: e.prompt, model: e.model })
      return { result: 'done', text: 'done' }
    })
    await $.tool.call(privateEnforce)
    expect(seen).toEqual([{ description: privateEnforce.description, prompt: privateEnforce.prompt, model: 'opus' }])
    expect(writes.map(w => w.path)).toEqual(['/home/t/.taskshape/decisions.jsonl', '/home/t/.taskshape/outcomes.jsonl'])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.mode).toBe('enforced')
    expect(decision.shape).toBe('coupled')
    expect(decision.profile).toBe('opus')
    expect('description' in decision).toBe(false)
    const outcome = JSON.parse(files['/home/t/.taskshape/outcomes.jsonl'].trim())
    expect(outcome.outcome).toBe('enforced')
    expect(outcome.model).toBe('claude-opus-5-5')
    expectNoRawTaskText(files, writes, privateEnforce)
  })

  test('default Laya backend classifies through runtime-cli stdin and then applies the profile policy', async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    const runs: { argv: readonly string[]; init?: { stdin?: string; timeoutMs?: number } }[] = []
    const seen: unknown[] = []
    wire(on, files, writes)
    on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string; timeoutMs?: number } }) => {
      runs.push(e)
      return ok(layaDecision('coupled'))
    })
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { description?: string; prompt?: string; model?: string }) => {
      seen.push({ description: e.description, prompt: e.prompt, model: e.model })
      return { result: 'done', text: 'done' }
    })
    await $.tool.call(privateEnforce)
    expect(runs.length).toBe(1)
    expect(runs[0].argv[0]).toBe('sh')
    expect(runs[0].argv[1]).toMatch(/\/hooks\/launch\.sh$/)
    expect(runs[0].argv.slice(2)).toEqual(['runtime-cli.ts', 'classify'])
    expect(JSON.parse(runs[0].init?.stdin || '{}')).toEqual({ task: privateEnforce.prompt, phase: 'work' })
    expect(runs[0].init?.timeoutMs).toBe(30000)
    expect(seen).toEqual([{ description: privateEnforce.description, prompt: privateEnforce.prompt, model: 'opus' }])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.source).toBe('laya')
    expect(decision.answer_confidence).toBe(0.91)
    expect(decision.shape).toBe('coupled')
    expect(decision.profile).toBe('opus')
    expectNoRawTaskText(files, writes, privateEnforce)
  })

  test('default Laya setup failure leaves the Agent launch unchanged without persisting private task text', async ($, on) => {
    const files: Record<string, string> = {}
    const writes: Written[] = []
    const seen: unknown[] = []
    wire(on, files, writes)
    on('process.run', () => ({ value: { exitCode: 2, stdout: '', stderr: 'runtime setup unavailable', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { description?: string; prompt?: string; model?: string }) => {
      seen.push({ description: e.description, prompt: e.prompt, model: e.model })
      return { result: 'done', text: 'done' }
    })
    await $.tool.call(privateEnforce)
    expect(seen).toEqual([{ description: privateEnforce.description, prompt: privateEnforce.prompt, model: undefined }])
    expect(writes).toEqual([])
    expectNoRawTaskText(files, writes, privateEnforce)
  })

  test('CLAUDE_PLUGIN_DATA wins over the home folder', { options: { mode: 'suggest', backend: 'heuristic' } }, async ($, on) => {
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

  test('two concurrent launches keep both audit lines', { options: { backend: 'heuristic' } }, async ($, on) => {
    const files: Record<string, string> = {}
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, () => ({ result: 'done', text: 'done' }))
    await Promise.all([$.tool.call(coupled), $.tool.call(typo)])
    const decisions = files['/home/t/.taskshape/decisions.jsonl'].trim().split('\n').map(line => JSON.parse(line))
    expect(decisions.map(d => d.shape).sort()).toEqual(['coupled', 'routine'])
    expect(files['/home/t/.taskshape/outcomes.jsonl'].trim().split('\n').length).toBe(2)
  })
})

describe('named agents', () => {
  const architect = { ...coupled, subagent_type: 'oh-my-claudecode:architect' }
  const launch = async ($: any, on: any) => {
    const seen: unknown[] = []
    wire(on, {}, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { subagent_type?: string; model?: string }) => { seen.push([e.subagent_type, e.model]); return { result: 'done', text: 'done' } })
    await $.tool.call(architect)
    await $.tool.call({ ...coupled, subagent_type: 'general-purpose' })
    await $.tool.call(coupled)
    return seen
  }

  test('a named agent keeps its own model; general-purpose and untyped launches are routed', { options: { mode: 'enforce', backend: 'heuristic' } }, async ($, on) => {
    expect(await launch($, on)).toEqual([['oh-my-claudecode:architect', undefined], ['general-purpose', 'opus'], [undefined, 'opus']])
  })

  test('routeNamedAgents routes a named agent too', { options: { mode: 'enforce', backend: 'heuristic', routeNamedAgents: true } }, async ($, on) => {
    expect(await launch($, on)).toEqual([['oh-my-claudecode:architect', 'opus'], ['general-purpose', 'opus'], [undefined, 'opus']])
  })
})

describe('profiles file', () => {
  test('a valid profiles.json replaces the built-in table', { options: { mode: 'enforce', backend: 'heuristic', profiles: '/etc/p.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/p.json': JSON.stringify({ version: 1, profiles: [
      { id: 'only-sonnet', model: 'claude-sonnet-5-5', capability: 4, cost_tier: 1, phases: ['work', 'review'] }] }) }
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual(['sonnet'])
    expect(JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim()).profile).toBe('only-sonnet')
  })

  test('an invalid profiles.json never rewrites the launch with the built-in table and records a warning', { options: { mode: 'enforce', backend: 'heuristic', profiles: '/etc/bad.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/bad.json': '{"version": 2}' }
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual([undefined])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.mode).toBe('suggested')
    expect(decision.warnings.join(' ')).toContain('profiles file unusable')
    const outcome = JSON.parse(files['/home/t/.taskshape/outcomes.jsonl'].trim())
    expect(outcome.profile).toBe(null)
    expect(outcome.suggested_profile).toBe('opus')
  })

  test('an unreadable profiles.json never rewrites the launch', { options: { mode: 'enforce', backend: 'heuristic', profiles: '/etc/missing.json' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual([undefined])
    expect(JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim()).warnings.join(' ')).toContain('profiles file unusable')
  })
})

describe('budget', () => {
  test('an unknown budget name does not fall back to the default tier: the launch stays unchanged with a warning', { options: { mode: 'enforce', backend: 'heuristic', budget: 'ecnomy' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual([undefined])
    const decision = JSON.parse(files['/home/t/.taskshape/decisions.jsonl'].trim())
    expect(decision.mode).toBe('suggested')
    expect(decision.warnings.join(' ')).toContain('unknown budget "ecnomy"')
    expect(JSON.parse(files['/home/t/.taskshape/outcomes.jsonl'].trim()).profile).toBe(null)
  })

  test('a budget the profiles file defines still caps the choice', { options: { mode: 'enforce', backend: 'heuristic', budget: 'tight', profiles: '/etc/p.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/p.json': JSON.stringify({ version: 1, budgets: { tight: { max_cost_tier: 1 } }, profiles: [
      { id: 'cheap', model: 'claude-haiku-4-5', capability: 2, cost_tier: 1 },
      { id: 'big', model: 'claude-opus-5-5', capability: 4, cost_tier: 4 }] }) }
    const seen: unknown[] = []
    wire(on, files, [])
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { model?: string }) => { seen.push(e.model); return { result: 'done', text: 'done' } })
    await $.tool.call(coupled)
    expect(seen).toEqual(['haiku'])
  })
})

describe('python command', () => {
  test('uses the CLI decision when a command is configured', { options: { mode: 'enforce', command: '/opt/taskshape', profiles: '/etc/p.json' } }, async ($, on) => {
    const files: Record<string, string> = { '/etc/p.json': JSON.stringify({ version: 1, profiles: [{ id: 'sol61-high', model: 'gpt-6.1-sol', capability: 3, cost_tier: 3 }] }) }
    const runs: { argv: string[]; stdin?: string }[] = []
    const seen: unknown[] = []
    wire(on, files, [])
    on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
      runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
      return ok(cliDecision('claude-opus-5-5'))
    })
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { description?: string; prompt?: string; model?: string }) => {
      seen.push({ description: e.description, prompt: e.prompt, model: e.model })
      return { result: 'done', text: 'done' }
    })
    await $.tool.call(privateEnforce)
    expect(seen).toEqual([{ description: privateEnforce.description, prompt: privateEnforce.prompt, model: 'opus' }])
    expect(runs.length).toBe(1)
    expect(runs[0].argv.slice(0, 2)).toEqual(['/opt/taskshape', 'route'])
    expect(runs[0].argv).toContain('/etc/p.json')
    expect(runs[0].argv).toContain('--task-stdin')
    expect(runs[0].argv).not.toContain('--task')
    expect(JSON.stringify(runs[0].argv)).not.toContain(privateEnforce.prompt)
    expect(runs[0].stdin).toBe(privateEnforce.prompt)
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

  test('a failing CLI skips routing and leaves the launch unchanged', { options: { mode: 'enforce', command: '/opt/taskshape' } }, async ($, on) => {
    const files: Record<string, string> = {}
    const seen: unknown[] = []
    const writes: Written[] = []
    wire(on, files, writes)
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'ValueError: boom', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', { tool: 'Agent' }, (_: unknown, e: { description?: string; prompt?: string; model?: string }) => {
      seen.push({ description: e.description, prompt: e.prompt, model: e.model })
      return { result: 'done', text: 'done' }
    })
    await $.tool.call(privateEnforce)
    expect(seen).toEqual([{ description: privateEnforce.description, prompt: privateEnforce.prompt, model: undefined }])
    expect(writes).toEqual([])
    expectNoRawTaskText(files, writes, privateEnforce)
  })
})
