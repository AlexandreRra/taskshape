import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyLocal, downloadArtifact, ensureRuntime, runtimeDir, selectContextLocal, shouldReadFileLocal, validateClassification, validateContextSelection, validateFileRelevance } from './runtime.ts'

const here = import.meta.dirname

const probability = { lookup: 0.1, routine: 0.1, demanding: 0.1, visual: 0.1, coupled: 0.5, architecture: 0.1 }
const POSIX = process.platform !== 'win32'
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

test('a typed local relevance answer skips only on a strong no', () => {
  const answer = { should_read: false, decision: 'no', path: 'src/auth.py', answer_confidence: 0.91,
    relevance_probabilities: { yes: 0.09, no: 0.91 }, reason: 'skip', source: 'laya', warnings: [] }
  assert.equal(validateFileRelevance(answer, 'src/auth.py').should_read, false)
  for (const invalid of [
    { ...answer, relevance_probabilities: { yes: 0.3, no: 0.7 } },
    { ...answer, relevance_probabilities: { yes: 0.5, no: 0.5 } },
    { ...answer, decision: 'yes' },
    { ...answer, relevance_probabilities: { yes: Number.NaN, no: 0.91 } },
    { ...answer, relevance_probabilities: { yes: 0.09 } },
    { ...answer, path: 'different-file.py' },
    { ...answer, answer_confidence: null },
  ]) assert.throws(() => validateFileRelevance(invalid, 'src/auth.py'))
  const fallback = validateFileRelevance({ source: 'conservative-fallback', warnings: ['private backend text'] }, 'src/auth.py')
  assert.equal(JSON.stringify(fallback).includes('private backend text'), false)
})

const installReadyRuntime = (home: string, pythonBody: string): string => {
  const previous = process.env.TASKSHAPE_HOME
  process.env.TASKSHAPE_HOME = home
  try {
    const checkpoint = join(home, 'checkpoint')
    mkdirSync(checkpoint, { recursive: true })
    writeFileSync(join(checkpoint, 'rl_agent_config.json'), '{}')
    const python = join(home, 'fake-python.sh')
    writeFileSync(python, pythonBody, { mode: 0o700 })
    chmodSync(python, 0o700)
    const root = runtimeDir()
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'status.json'), JSON.stringify({ state: 'ready', message: 'ready', python, checkpoint }))
    return python
  } finally {
    if (previous === undefined) delete process.env.TASKSHAPE_HOME
    else process.env.TASKSHAPE_HOME = previous
  }
}

test('runtime CLI asks file relevance through stdin without argv context', { skip: !POSIX }, () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-relevance-home-'))
  const stdinCapture = join(home, 'stdin.json')
  const argvCapture = join(home, 'argv.txt')
  const secretTask = 'Fix login without leaking this task'
  const secretExcerpt = 'private excerpt token'
  try {
    installReadyRuntime(home, `#!/bin/sh
printf '%s' "$*" > "$TASKSHAPE_ARG_CAPTURE"
cat > "$TASKSHAPE_STDIN_CAPTURE"
cat <<'JSON'
{"should_read":false,"decision":"no","path":"src/auth.py","answer_confidence":0.91,"relevance_probabilities":{"yes":0.09,"no":0.91},"reason":"skip","source":"laya","warnings":[]}
JSON
`)
    const ran = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', join(here, 'runtime-cli.ts'), 'should-read-file'], {
      input: JSON.stringify({ task: secretTask, path: 'src/auth.py', summary: 'auth module', excerpt: secretExcerpt }),
      encoding: 'utf8',
      env: { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_STDIN_CAPTURE: stdinCapture, TASKSHAPE_ARG_CAPTURE: argvCapture },
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(JSON.parse(ran.stdout).should_read, false)
    const captured = JSON.parse(readFileSync(stdinCapture, 'utf8'))
    assert.equal(captured.operation, 'should_read_file')
    assert.equal(captured.task, secretTask)
    assert.equal(captured.excerpt, secretExcerpt)
    assert.equal(readFileSync(argvCapture, 'utf8').includes(secretTask), false)
    assert.equal(readFileSync(argvCapture, 'utf8').includes(secretExcerpt), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('file relevance subprocess failures and malformed answers fail open without leaking context', { skip: !POSIX }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-relevance-fallback-'))
  try {
    installReadyRuntime(home, `#!/bin/sh
printf 'private task leaked' >&2
printf '{"should_read":false,"decision":"no","path":"docs/nope.md","answer_confidence":0.7,"relevance_probabilities":{"yes":0.3,"no":0.7},"reason":"weak","source":"laya","warnings":[]}'
`)
    const previous = process.env.TASKSHAPE_HOME
    process.env.TASKSHAPE_HOME = home
    try {
      const decision = await shouldReadFileLocal('private task leaked', 'docs/nope.md', '', 'private excerpt leaked')
      assert.equal(decision.should_read, true)
      assert.equal(decision.decision, null)
      assert.equal(decision.answer_confidence, null)
      assert.equal(decision.relevance_probabilities, null)
      assert.equal(decision.source, 'conservative-fallback')
      assert.equal(JSON.stringify(decision).includes('private task leaked'), false)
      assert.equal(JSON.stringify(decision).includes('private excerpt leaked'), false)
    } finally {
      if (previous === undefined) delete process.env.TASKSHAPE_HOME
      else process.env.TASKSHAPE_HOME = previous
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('runtime CLI selects context in one stdin batch with default root and bounded options', { skip: !POSIX }, () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-context-home-'))
  const stdinCapture = join(home, 'stdin.json')
  const argvCapture = join(home, 'argv.txt')
  const secretTask = `${'x'.repeat(4100)} final directive must survive`
  try {
    installReadyRuntime(home, `#!/bin/sh
printf '%s' "$*" > "$TASKSHAPE_ARG_CAPTURE"
cat > "$TASKSHAPE_STDIN_CAPTURE"
cat <<'JSON'
{"files":[{"path":"src/auth.py","should_read":true,"ranges":[{"start_line":2,"end_line":5}],"total_lines":10,"complete":true,"source":"laya","warnings":[]},{"path":"docs/nope.md","should_read":false,"ranges":[],"total_lines":20,"complete":true,"source":"laya","warnings":[]}],"warnings":[]}
JSON
`)
    const ran = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', join(here, 'runtime-cli.ts'), 'select-context'], {
      input: JSON.stringify({ task: secretTask, paths: ['src/auth.py', 'docs/nope.md'], skip_threshold: 0.95, max_chunks: 12 }),
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_STDIN_CAPTURE: stdinCapture, TASKSHAPE_ARG_CAPTURE: argvCapture },
    })
    assert.equal(ran.status, 0, ran.stderr)
    const output = JSON.parse(ran.stdout)
    assert.equal(output.files.length, 2)
    assert.equal(output.files[0].ranges[0].start_line, 2)
    assert.equal(output.files[1].should_read, false)
    assert.equal(JSON.stringify(output).includes(secretTask), false)
    const captured = JSON.parse(readFileSync(stdinCapture, 'utf8'))
    assert.equal(captured.operation, 'select_context')
    assert.deepEqual(captured.paths, ['src/auth.py', 'docs/nope.md'])
    assert.equal(captured.task, secretTask)
    assert.equal(captured.root, home)
    assert.equal(captured.skip_threshold, 0.95)
    assert.equal(captured.max_file_bytes, 262144)
    assert.equal(captured.chunk_lines, 80)
    assert.equal(captured.max_chunks, 12)
    assert.equal(captured.batch_size, 8)
    assert.equal(captured.head_max_len, 320)
    assert.equal(readFileSync(argvCapture, 'utf8').includes(secretTask), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('runtime CLI dedupes context paths before calling local Laya', { skip: !POSIX }, () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-context-dedupe-'))
  const stdinCapture = join(home, 'stdin.json')
  try {
    installReadyRuntime(home, `#!/bin/sh
cat > "$TASKSHAPE_STDIN_CAPTURE"
cat <<'JSON'
{"files":[{"path":"a.py","should_read":true,"ranges":[{"start_line":1,"end_line":1}],"total_lines":1,"complete":true,"source":"laya","warnings":[]}],"warnings":[]}
JSON
`)
    const ran = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', join(here, 'runtime-cli.ts'), 'select-context'], {
      input: JSON.stringify({ task: 'Fix duplicate handling', paths: ['a.py', 'a.py'] }),
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, TASKSHAPE_HOME: home, TASKSHAPE_STDIN_CAPTURE: stdinCapture },
    })
    assert.equal(ran.status, 0, ran.stderr)
    const output = JSON.parse(ran.stdout)
    assert.equal(output.files.length, 1)
    assert.equal(output.files[0].path, 'a.py')
    assert.equal(output.files[0].source, 'laya')
    assert.deepEqual(JSON.parse(readFileSync(stdinCapture, 'utf8')).paths, ['a.py'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('context selection subprocess failures and malformed answers fail open per path without leaking context', { skip: !POSIX }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-context-fallback-'))
  try {
    installReadyRuntime(home, `#!/bin/sh
printf 'private context task leaked' >&2
printf '{"files":[{"path":"src/auth.py","should_read":false,"ranges":[],"total_lines":10,"complete":false,"source":"laya","warnings":[]}],"warnings":[]}'
`)
    const previous = process.env.TASKSHAPE_HOME
    process.env.TASKSHAPE_HOME = home
    try {
      const selection = await selectContextLocal('private context task leaked', ['src/auth.py'], { root: home })
      assert.equal(selection.files.length, 1)
      assert.equal(selection.files[0].should_read, true)
      assert.deepEqual(selection.files[0].ranges, [])
      assert.equal(selection.files[0].total_lines, null)
      assert.equal(selection.files[0].complete, false)
      assert.equal(selection.files[0].source, 'conservative-fallback')
      assert.equal(JSON.stringify(selection).includes('private context task leaked'), false)
    } finally {
      if (previous === undefined) delete process.env.TASKSHAPE_HOME
      else process.env.TASKSHAPE_HOME = previous
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('context selection validator rejects incomplete skips and invalid ranges', async () => {
  const valid = { files: [{ path: 'src/auth.py', should_read: true, ranges: [{ start_line: 1, end_line: 3 }], total_lines: 4, complete: false, source: 'laya', warnings: [] }], warnings: [] }
  assert.equal(validateContextSelection(valid, ['src/auth.py']).files[0].ranges[0].end_line, 3)
  const emptyFile = { files: [{ path: 'empty.py', should_read: true, ranges: [], total_lines: 0, complete: true, source: 'laya', warnings: [], raw_content: 'private file text' }], warnings: ['private task text'], task: 'private task text' }
  const sanitized = validateContextSelection(emptyFile, ['empty.py'])
  assert.equal(sanitized.files[0].total_lines, 0)
  assert.equal(JSON.stringify(sanitized).includes('private file text'), false)
  assert.equal(JSON.stringify(sanitized).includes('private task text'), false)
  const knownIncompleteFallback = validateContextSelection({
    files: [{ path: 'known3.py', should_read: true, ranges: [{ start_line: 1, end_line: 3 }], total_lines: 3, complete: false, source: 'conservative-fallback', warnings: ['private backend note'] }],
    warnings: ['private response note'],
  }, ['known3.py'])
  assert.deepEqual(knownIncompleteFallback.files[0].ranges, [{ start_line: 1, end_line: 3 }])
  assert.equal(knownIncompleteFallback.files[0].complete, false)
  assert.equal(knownIncompleteFallback.files[0].total_lines, 3)
  assert.equal(JSON.stringify(knownIncompleteFallback).includes('private backend note'), false)
  const knownCompleteFallback = validateContextSelection({
    files: [{ path: 'known2.py', should_read: true, ranges: [{ start_line: 1, end_line: 2 }], total_lines: 2, complete: true, source: 'conservative-fallback', warnings: [] }],
    warnings: [],
  }, ['known2.py'])
  assert.equal(knownCompleteFallback.files[0].complete, true)
  assert.deepEqual(knownCompleteFallback.files[0].ranges, [{ start_line: 1, end_line: 2 }])
  for (const invalid of [
    { files: [{ path: 'src/auth.py', should_read: false, ranges: [], total_lines: 4, complete: false, source: 'laya', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: true, ranges: [{ start_line: 3, end_line: 6 }], total_lines: 4, complete: true, source: 'laya', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: true, ranges: [{ start_line: 1, end_line: 3 }, { start_line: 3, end_line: 4 }], total_lines: 4, complete: true, source: 'laya', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: true, ranges: [], total_lines: null, complete: false, source: 'laya', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: false, ranges: [], total_lines: null, complete: false, source: 'conservative-fallback', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: true, ranges: [{ start_line: 1, end_line: 1 }], total_lines: null, complete: false, source: 'conservative-fallback', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: true, ranges: [], total_lines: null, complete: true, source: 'conservative-fallback', warnings: [] }], warnings: [] },
    { files: [{ path: 'src/auth.py', should_read: true, ranges: [{ start_line: 2, end_line: 3 }], total_lines: 2, complete: false, source: 'conservative-fallback', warnings: [] }], warnings: [] },
    { files: [{ path: 'other.py', should_read: true, ranges: [], total_lines: 4, complete: true, source: 'laya', warnings: [] }], warnings: [] },
  ]) assert.throws(() => validateContextSelection(invalid, ['src/auth.py']))
  await assert.rejects(selectContextLocal('task', Array.from({ length: 21 }, (_, index) => `f${index}.py`)))
  await assert.rejects(selectContextLocal('task', ['a.py'], { skip_threshold: 0.49 }))
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

const withEnv = async (values: Record<string, string>, body: () => unknown | Promise<unknown>): Promise<void> => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  try { await body() } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('every Python call runs in UTF-8 mode and non-ASCII text crosses the pipe intact', { skip: !POSIX }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-utf8-'))
  const argvCapture = join(home, 'argv.txt')
  const stdinCapture = join(home, 'stdin.txt')
  const task = 'Corrigir a validação do cadastro — 日本語 ✓ 🚀'
  try {
    installReadyRuntime(home, `#!/bin/sh
printf '%s\\n' "$*" >> "$TASKSHAPE_ARG_CAPTURE"
cat >> "$TASKSHAPE_STDIN_CAPTURE"
echo >> "$TASKSHAPE_STDIN_CAPTURE"
cat <<'JSON'
{"shape":"coupled","answer_confidence":0.5,"shape_probabilities":{"lookup":0.1,"routine":0.1,"demanding":0.1,"visual":0.1,"coupled":0.5,"architecture":0.1},"source":"laya"}
JSON
`)
    await withEnv({ TASKSHAPE_HOME: home, TASKSHAPE_ARG_CAPTURE: argvCapture, TASKSHAPE_STDIN_CAPTURE: stdinCapture }, async () => {
      assert.equal((await classifyLocal(task)).shape, 'coupled')
      await shouldReadFileLocal(task, 'src/ação.py', 'resumo — ✓', 'trecho 日本語')
      await selectContextLocal(task, ['src/ação.py'], { root: home })
    })
    const argvLines = readFileSync(argvCapture, 'utf8').trim().split('\n')
    assert.equal(argvLines.length, 3)
    for (const line of argvLines) assert.match(line, /^-X utf8 -I .*classify\.py /)
    const stdin = readFileSync(stdinCapture)
    assert.equal(stdin.includes(Buffer.from(task, 'utf8')), true)
    const requests = stdin.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(requests[0].task, task)
    assert.equal(requests[1].excerpt, 'trecho 日本語')
    assert.equal(requests[2].paths[0], 'src/ação.py')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('context selection gives Python a time budget', { skip: !POSIX }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'taskshape-budget-'))
  const stdinCapture = join(home, 'stdin.json')
  try {
    installReadyRuntime(home, `#!/bin/sh
cat > "$TASKSHAPE_STDIN_CAPTURE"
`)
    await withEnv({ TASKSHAPE_HOME: home, TASKSHAPE_STDIN_CAPTURE: stdinCapture }, () => selectContextLocal('Fix it', ['a.py'], { root: home }))
    assert.equal(JSON.parse(readFileSync(stdinCapture, 'utf8')).time_budget, 45)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('context selection forwards only known fixed warnings and counts the rest', () => {
  const known = 'file exceeds the local read limit; reading is recommended'
  const answer = {
    files: [{ path: 'a.py', should_read: true, ranges: [], total_lines: null, complete: false, source: 'conservative-fallback',
      warnings: [known, known, 'Invalid token in /home/me/secret-project/a.py', 42, `${known}\nsecond line`, 'file '.repeat(60)] }],
    warnings: ['chunk budget reached before complete coverage; the whole file is recommended', 'task: private words'],
  }
  const result = validateContextSelection(answer, ['a.py'], ['task truncated to 4000 characters'])
  assert.equal(result.files[0].warnings.filter(warning => warning === known).length, 1)
  assert.equal(result.files[0].warnings.includes('Local context selection returned 4 other warning(s)'), true)
  const deadline = validateContextSelection({ files: [{ path: 'a.py', should_read: true, ranges: [{ start_line: 1, end_line: 2 }], total_lines: 2, complete: false, source: 'conservative-fallback',
    warnings: ['time budget exhausted before this chunk was evaluated; reading is recommended', 'Laya token accounting failed; reading is recommended'] }], warnings: [] }, ['a.py'])
  assert.deepEqual(deadline.files[0].warnings, ['time budget exhausted before this chunk was evaluated; reading is recommended', 'Laya token accounting failed; reading is recommended'])
  assert.deepEqual(result.warnings, ['task truncated to 4000 characters',
    'chunk budget reached before complete coverage; the whole file is recommended', 'Local context selection returned 1 other warning(s)'])
  const text = JSON.stringify(result)
  for (const secret of ['secret-project', 'second line', 'private words']) assert.equal(text.includes(secret), false, secret)
})
