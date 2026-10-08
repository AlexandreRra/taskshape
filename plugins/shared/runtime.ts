// Provisioned locally on first use. Classification never sends task text over the network.
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { shapesFor, type Phase, type Shape } from './shapes.ts'

export type RuntimeStatus = { state: 'installing' | 'ready' | 'error'; message: string; python?: string; checkpoint?: string; updated?: number }
export type Classification = { shape: Shape; answer_confidence: number; shape_probabilities: Record<string, number>; source: 'laya' }
export type FileRelevance = {
  should_read: boolean
  decision: 'yes' | 'no' | null
  path: string
  answer_confidence: number | null
  relevance_probabilities: Record<'yes' | 'no', number> | null
  reason: string
  source: 'laya' | 'conservative-fallback'
  warnings: string[]
}
export type ContextRange = { start_line: number; end_line: number }
export type ContextSelectionFile = {
  path: string
  should_read: boolean
  ranges: ContextRange[]
  total_lines: number | null
  complete: boolean
  source: 'laya' | 'conservative-fallback'
  warnings: string[]
}
export type ContextSelection = { files: ContextSelectionFile[]; warnings: string[] }
export type ContextSelectionOptions = {
  root?: string
  skip_threshold?: number
  max_file_bytes?: number
  chunk_lines?: number
  max_chunks?: number
  batch_size?: number
}
type Artifact = { url: string; sha256: string; path?: string; size?: number; executable?: string }
type Assets = { version: number; python: string; uv: Record<string, Artifact>; model: { revision: string; files: Artifact[] } }
const RELEVANCE_LIMITS = { task: 4000, path: 1000, summary: 2000, excerpt: 4000 } as const
const RELEVANCE_SKIP_THRESHOLD = 0.8
const CONTEXT_SELECTION_DEFAULTS = {
  skip_threshold: 0.95,
  max_file_bytes: 262_144,
  chunk_lines: 80,
  max_chunks: 64,
  batch_size: 8,
  head_max_len: 320,
  // Seconds the Python process may use in total (lock wait and model load included); spawnSync waits this plus CONTEXT_PROCESS_OVERHEAD_S.
  time_budget: 45,
} as const
const CONTEXT_MAX_PATHS = 20
const CONTEXT_PROCESS_OVERHEAD_S = 20
// An install that has run this long is treated as dead even if its PID answers: the PID may belong to an unrelated
// process now. Two hours covers the slowest legitimate setup (about 650 MB of model plus Python and CPU wheels over a poor link).
const INSTALL_LOCK_MAX_AGE_MS = 2 * 60 * 60_000
// Runtimes of other payload hashes are removed only when unused for this long, so a second plugin on an
// older payload is never deleted from under it while it keeps being used.
const STALE_RUNTIME_MIN_AGE_MS = 7 * 24 * 60 * 60_000
// A ready runtime records its use in this marker file at most once per interval, so hooks do not write on every call.
const LAST_USED_FILE = 'last-used'
const LAST_USED_INTERVAL_MS = 24 * 60 * 60_000
const RUNTIME_HASH = /^[a-f0-9]{16}$/

const here = dirname(fileURLToPath(import.meta.url))
export const bundledRuntime = (): string => [join(here, '..', 'runtime'), join(here, '..', '..', 'runtime')]
  .find(path => existsSync(join(path, 'assets.json'))) ?? join(here, '..', 'runtime')
const payload = (): string => createHash('sha256').update(readFileSync(join(bundledRuntime(), 'assets.json')))
  .update(readFileSync(join(bundledRuntime(), 'requirements.lock'))).digest('hex').slice(0, 16)
export const runtimeDir = (): string => join(process.env.TASKSHAPE_HOME || join(homedir(), '.taskshape'), 'runtime', payload())
const statusPath = (): string => join(runtimeDir(), 'status.json')
// The owner file holds "<pid> <start time in ms>"; a bare PID (older installers) ages from the lock directory.
export const lockOwnerAlive = (dir: string = runtimeDir()): boolean => {
  const lock = join(dir, 'install.lock')
  try {
    const [pidText, startedText] = readFileSync(join(lock, 'pid'), 'utf8').trim().split(/\s+/)
    const pid = Number(pidText)
    if (!Number.isInteger(pid) || pid < 1) return false
    const started = startedText === undefined ? statSync(lock).mtimeMs : Number(startedText)
    if (!Number.isFinite(started) || Date.now() - started > INSTALL_LOCK_MAX_AGE_MS) return false
    process.kill(pid, 0)
    return true
  } catch {
    // Allow the installer a moment to write its PID after acquiring the lock.
    try { return Date.now() - statSync(lock).mtimeMs < 5_000 } catch { return false }
  }
}

// Best effort: a failed write only makes this runtime look older to the pruner.
export const markRuntimeUsed = (dir: string = runtimeDir()): void => {
  const marker = join(dir, LAST_USED_FILE)
  try {
    if (Date.now() - statSync(marker).mtimeMs < LAST_USED_INTERVAL_MS) return
    const now = new Date()
    utimesSync(marker, now, now)
  } catch {
    try { writeFileSync(marker, '', { mode: 0o600 }) } catch { /* read-only or racing runtime directory */ }
  }
}

// Last use is the marker's mtime; runtimes that never wrote one fall back to the directory's mtime (their last install).
const runtimeLastUsed = (dir: string): number => {
  try { return statSync(join(dir, LAST_USED_FILE)).mtimeMs } catch { return statSync(dir).mtimeMs }
}

// Best effort: stale runtimes only cost disk, so no failure here may affect an install that already succeeded.
export const pruneOtherRuntimes = (keep: string = runtimeDir(), minAgeMs: number = STALE_RUNTIME_MIN_AGE_MS): void => {
  try {
    const parent = dirname(keep)
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUNTIME_HASH.test(entry.name) || entry.name === basename(keep)) continue
      const dir = join(parent, entry.name)
      try {
        if (Date.now() - runtimeLastUsed(dir) < minAgeMs || lockOwnerAlive(dir)) continue
        rmSync(dir, { recursive: true, force: true })
      } catch { /* leave it for the next install */ }
    }
  } catch { /* no runtimes directory to prune */ }
}

const pythonArgs = (checkpoint: string): string[] => ['-X', 'utf8', '-I', join(bundledRuntime(), 'classify.py'), checkpoint]

const status = (): RuntimeStatus | undefined => {
  try { return JSON.parse(readFileSync(statusPath(), 'utf8')) as RuntimeStatus } catch { return undefined }
}
const saveStatus = (value: RuntimeStatus): RuntimeStatus => {
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 })
  const temp = `${statusPath()}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify({ ...value, updated: Date.now() }), { mode: 0o600 })
  renameSync(temp, statusPath())
  return value
}

export const ensureRuntime = async (): Promise<RuntimeStatus> => {
  const current = status()
  if (current?.state === 'ready' && current.python && current.checkpoint
    && existsSync(current.python) && existsSync(join(current.checkpoint, 'rl_agent_config.json'))) {
    markRuntimeUsed()
    return current
  }
  if (current?.state === 'installing' && (lockOwnerAlive() || Date.now() - (current.updated ?? 0) < 5_000)) return current
  if (current?.state === 'error' && Date.now() - (current.updated ?? 0) < 60_000) return current
  const pending = saveStatus({ state: 'installing', message: 'Taskshape is preparing local Laya. Python, dependencies and the model are downloaded once; routing starts when setup finishes.' })
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', fileURLToPath(import.meta.url), '--install'],
    { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => saveStatus({ state: 'error', message: 'Taskshape could not start local Laya setup.' }))
  child.unref()
  return pending
}

// Downloads are written atomically and verified before any downloaded executable is run.
export const downloadArtifact = async (artifact: Artifact, destination: string, request: typeof fetch = fetch): Promise<void> => {
  if (!/^https:\/\//.test(artifact.url) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid pinned download')
  if (existsSync(destination)) {
    const { createReadStream } = await import('node:fs')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(destination)) hash.update(chunk)
    if (hash.digest('hex') === artifact.sha256) return
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const partial = `${destination}.${randomUUID()}.part`
  const response = await request(artifact.url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body || (response.url && !response.url.startsWith('https://'))) throw new Error('Pinned download failed')
  const hash = createHash('sha256')
  let bytes = 0
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > (artifact.size ?? 200_000_000)) return callback(new Error('Pinned download is larger than expected'))
        hash.update(chunk)
        callback(null, chunk)
      },
    }), createWriteStream(partial, { mode: 0o600 }))
    if ((artifact.size !== undefined && bytes !== artifact.size) || hash.digest('hex') !== artifact.sha256) throw new Error('Pinned download failed integrity verification')
    renameSync(partial, destination)
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
}

const run = (command: string, args: string[], env: NodeJS.ProcessEnv): void => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 20 * 60_000, windowsHide: true, maxBuffer: 4_000_000 })
  if (result.status !== 0) {
    const detail = env.TASKSHAPE_DEBUG_INSTALL === '1'
      ? ` Exit ${result.status ?? 'signal'} on ${process.platform}/${process.arch}. ${result.error?.message ?? ''} stdout: ${(result.stdout ?? '').slice(-2_000)} stderr: ${(result.stderr ?? '').slice(-2_000)}`
      : ''
    throw new Error(`Local Laya setup failed at ${args[0]}. Check network access, free disk space and platform support; retry by starting a new session.${detail}`)
  }
}

export const installRuntime = async (): Promise<void> => {
  const current = status()
  if (current?.state === 'ready' && current.python && current.checkpoint && existsSync(current.python)
    && existsSync(join(current.checkpoint, 'rl_agent_config.json'))) return
  const root = runtimeDir()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = join(root, 'install.lock')
  try { mkdirSync(lock, { mode: 0o700 }) } catch {
    if (lockOwnerAlive()) return
    rmSync(lock, { recursive: true, force: true })
    try { mkdirSync(lock, { mode: 0o700 }) } catch { return }
  }
  writeFileSync(join(lock, 'pid'), `${process.pid} ${Date.now()}`, { mode: 0o600 })
  try {
    const assets = JSON.parse(readFileSync(join(bundledRuntime(), 'assets.json'), 'utf8')) as Assets
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform
    const asset = assets.uv[`${platform}-${process.arch}`]
    if (!asset?.executable) throw new Error(`Local Laya is not packaged for ${process.platform}/${process.arch}.`)
    saveStatus({ state: 'installing', message: 'Taskshape: downloading the verified Python installer.' })
    const archive = join(root, process.platform === 'win32' ? 'uv.zip' : 'uv.tar.gz')
    await downloadArtifact(asset, archive)
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    run('tar', ['-xf', archive, '-C', bin], process.env)
    const uv = join(bin, asset.executable)
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_CACHE_DIR: join(root, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed',
      UV_PYTHON_DOWNLOADS: 'automatic', UV_NO_CONFIG: '1', UV_PYTHON: assets.python, PYTHONNOUSERSITE: '1' }
    const venv = join(root, 'venv')
    saveStatus({ state: 'installing', message: 'Taskshape: installing private Python and pinned CPU dependencies.' })
    run(uv, ['venv', '--python', assets.python, '--allow-existing', '--no-project', '--no-config', venv], env)
    const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const installArgs = ['pip', 'sync', '--python', python, '--require-hashes', '--only-binary', ':all:', '--no-config']
    if (process.platform !== 'darwin') installArgs.push('--torch-backend', 'cpu')
    installArgs.push(join(bundledRuntime(), 'requirements.lock'))
    run(uv, installArgs, env)
    const modelRoot = join(root, 'checkpoint')
    const checkpoint = join(modelRoot, 'multilingual')
    saveStatus({ state: 'installing', message: 'Taskshape: downloading the verified multilingual Laya model (about 650 MB).' })
    for (const modelFile of assets.model.files) {
      if (!modelFile.path || modelFile.path.split(/[\\/]/).includes('..') || modelFile.path.startsWith('/')) throw new Error('Invalid bundled model path')
      await downloadArtifact(modelFile, join(modelRoot, modelFile.path))
    }
    saveStatus({ state: 'installing', message: 'Taskshape: checking local Laya inference.' })
    const check = spawnSync(python, pythonArgs(checkpoint), {
      env: { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
      input: JSON.stringify({ task: 'Find the filename that contains the exact setting name.', phase: 'work' }), encoding: 'utf8', timeout: 60_000, windowsHide: true,
    })
    if (check.status !== 0) throw new Error('Laya was downloaded but its local inference check failed.')
    validateClassification(JSON.parse(check.stdout), 'work')
    saveStatus({ state: 'ready', message: 'Taskshape: local Laya is ready.', python, checkpoint })
    pruneOtherRuntimes(root)
  } catch (error) {
    saveStatus({ state: 'error', message: error instanceof Error ? error.message : 'Local Laya setup failed.' })
  } finally { rmSync(lock, { recursive: true, force: true }) }
}

export const validateClassification = (raw: unknown, phase: Phase = 'work'): Classification => {
  const value = raw as Classification
  const options = shapesFor(phase)
  if (!value || value.source !== 'laya' || !options.includes(value.shape) || !Number.isFinite(value.answer_confidence)
    || value.answer_confidence < 0 || value.answer_confidence > 1 || !value.shape_probabilities) throw new Error('Invalid local Laya answer')
  const probs = value.shape_probabilities
  if (Object.keys(probs).length !== options.length || options.some(key => !Number.isFinite(probs[key]) || probs[key] < 0 || probs[key] > 1)
    || Math.abs(Object.values(probs).reduce((a, b) => a + b, 0) - 1) > 0.002
    || probs[value.shape] < Math.max(...Object.values(probs)) - 1e-9) throw new Error('Invalid local Laya distribution')
  return value
}

const requireText = (name: string, value: unknown, nonempty = false): string => {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  if (nonempty && !value.trim()) throw new Error(`${name} must be nonempty`)
  return value
}

const requireFiniteNumber = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a finite number between ${min} and ${max}`)
  }
  return value
}

const requireInteger = (name: string, value: unknown, min: number, max: number): number => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

const boundedRelevanceRequest = (task: string, path: string, summary: string, excerpt: string): { request: Record<string, string>; warnings: string[] } => {
  const request = { task, path, summary, excerpt }
  const warnings: string[] = []
  for (const key of Object.keys(RELEVANCE_LIMITS) as (keyof typeof RELEVANCE_LIMITS)[]) {
    const limit = RELEVANCE_LIMITS[key]
    if (request[key].length > limit) {
      request[key] = request[key].slice(0, limit)
      warnings.push(`${key} truncated to ${limit} characters for relevance classification`)
    }
  }
  return { request, warnings }
}

const conservativeFileRelevance = (path: string, warnings: string[] = []): FileRelevance => ({
  should_read: true,
  decision: null,
  path,
  answer_confidence: null,
  relevance_probabilities: null,
  reason: 'Reading is recommended because no reliable relevance decision was available.',
  source: 'conservative-fallback',
  warnings: [...warnings, 'Relevance backend unavailable or invalid; reading is recommended conservatively'],
})

const conservativeContextSelection = (paths: string[], warnings: string[] = []): ContextSelection => {
  const reason = 'Context selection backend unavailable or invalid; reading is recommended conservatively'
  return {
    files: paths.map(path => ({
      path,
      should_read: true,
      ranges: [],
      total_lines: null,
      complete: false,
      source: 'conservative-fallback',
      warnings: [...warnings, reason],
    })),
    warnings: [...warnings, reason],
  }
}

// Warnings written by the Python selector, matched by their stable leading words. Anything else could carry text
// from an exception or the task, so it is only counted.
const KNOWN_CONTEXT_WARNINGS = [
  'file is missing', 'file exceeds the local read limit', 'file could not be read', 'file appears to be binary',
  'file is not valid UTF-8 text', 'file contains an extremely long line', 'path could not be resolved safely',
  'path escapes the project root', 'path could not be inspected', 'path is not a regular file',
  'task and path did not fit the Laya token budget', 'a chunk did not fit the Laya token budget', 'Laya token accounting failed',
  'chunk budget reached before complete coverage', 'time budget exhausted', 'Laya truncated chunk evidence', 'Relevance evidence was truncated',
  'Relevance backend unavailable or invalid', 'Negative relevance answer was below the skip threshold',
] as const
const MAX_KNOWN_WARNING_LENGTH = 160

const safeWarnings = (warnings: unknown): string[] => {
  if (!Array.isArray(warnings)) return []
  const known = new Set<string>()
  let unknown = 0
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning.length <= MAX_KNOWN_WARNING_LENGTH && !/[\r\n]/.test(warning)
      && KNOWN_CONTEXT_WARNINGS.some(prefix => warning.startsWith(prefix))) known.add(warning)
    else unknown++
  }
  return [...known, ...(unknown > 0 ? [`Local context selection returned ${unknown} other warning(s)`] : [])]
}

const boundedContextSelectionRequest = (task: string, paths: string[], options: ContextSelectionOptions = {}): {
  request: {
    task: string
    paths: string[]
    root: string
    skip_threshold: number
    max_file_bytes: number
    chunk_lines: number
    max_chunks: number
    batch_size: number
    head_max_len: number
    time_budget: number
  }
  warnings: string[]
} => {
  task = requireText('task', task, true)
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array')
  if (paths.length === 0) throw new Error(`paths must contain 1-${CONTEXT_MAX_PATHS} entries`)
  const seen = new Set<string>()
  const cleanPaths: string[] = []
  paths.forEach((path, index) => {
    const clean = requireText(`paths[${index}]`, path, true)
    if (clean.length > RELEVANCE_LIMITS.path) throw new Error(`paths[${index}] must be at most ${RELEVANCE_LIMITS.path} characters`)
    if (seen.has(clean)) return
    seen.add(clean)
    cleanPaths.push(clean)
  })
  if (cleanPaths.length > CONTEXT_MAX_PATHS) throw new Error(`paths must contain 1-${CONTEXT_MAX_PATHS} unique entries`)
  const warnings: string[] = []
  return {
    request: {
      task,
      paths: cleanPaths,
      root: options.root === undefined ? process.cwd() : requireText('root', options.root, true),
      skip_threshold: options.skip_threshold === undefined ? CONTEXT_SELECTION_DEFAULTS.skip_threshold : requireFiniteNumber('skip_threshold', options.skip_threshold, 0.5, 1),
      max_file_bytes: options.max_file_bytes === undefined ? CONTEXT_SELECTION_DEFAULTS.max_file_bytes : requireInteger('max_file_bytes', options.max_file_bytes, 1, 1_048_576),
      chunk_lines: options.chunk_lines === undefined ? CONTEXT_SELECTION_DEFAULTS.chunk_lines : requireInteger('chunk_lines', options.chunk_lines, 1, 500),
      max_chunks: options.max_chunks === undefined ? CONTEXT_SELECTION_DEFAULTS.max_chunks : requireInteger('max_chunks', options.max_chunks, 1, 64),
      batch_size: options.batch_size === undefined ? CONTEXT_SELECTION_DEFAULTS.batch_size : requireInteger('batch_size', options.batch_size, 1, CONTEXT_MAX_PATHS),
      head_max_len: CONTEXT_SELECTION_DEFAULTS.head_max_len,
      time_budget: CONTEXT_SELECTION_DEFAULTS.time_budget,
    },
    warnings,
  }
}

export const validateFileRelevance = (raw: unknown, fallbackPath: string, requestWarnings: string[] = []): FileRelevance => {
  const value = raw as FileRelevance
  if (value?.source === 'conservative-fallback') return conservativeFileRelevance(fallbackPath, requestWarnings)
  if (!value || value.source !== 'laya' || typeof value.should_read !== 'boolean' || !['yes', 'no'].includes(value.decision ?? '')
    || value.path !== fallbackPath || typeof value.answer_confidence !== 'number' || !Number.isFinite(value.answer_confidence)
    || value.answer_confidence < 0 || value.answer_confidence > 1
    || !value.relevance_probabilities || typeof value.reason !== 'string' || !Array.isArray(value.warnings)) {
    throw new Error('Invalid local Laya relevance answer')
  }
  const probs = value.relevance_probabilities
  if (Object.keys(probs).length !== 2 || !Number.isFinite(probs.yes) || !Number.isFinite(probs.no) || probs.yes < 0 || probs.yes > 1
    || probs.no < 0 || probs.no > 1 || Math.abs(probs.yes + probs.no - 1) > 0.002
    || probs[value.decision as 'yes' | 'no'] < Math.max(probs.yes, probs.no) - 1e-9) throw new Error('Invalid local Laya relevance distribution')
  if (!value.should_read && (value.decision !== 'no' || probs.no < RELEVANCE_SKIP_THRESHOLD || probs.no <= probs.yes)) {
    throw new Error('Invalid local Laya relevance skip')
  }
  return {
    should_read: value.should_read,
    decision: value.decision as 'yes' | 'no',
    path: value.path,
    answer_confidence: Number(value.answer_confidence),
    relevance_probabilities: { yes: Number(probs.yes), no: Number(probs.no) },
    reason: value.reason,
    source: 'laya',
    warnings: [...requestWarnings, ...value.warnings.map(String)],
  }
}

const validateContextRanges = (ranges: unknown, totalLines: number): ContextRange[] => {
  if (!Array.isArray(ranges)) throw new Error('Invalid context selection ranges')
  let previousEnd = 0
  return ranges.map(range => {
    const value = range as ContextRange
    if (!Number.isInteger(value?.start_line) || !Number.isInteger(value?.end_line)
      || value.start_line < 1 || value.end_line < value.start_line || value.end_line > totalLines
      || value.start_line <= previousEnd) throw new Error('Invalid context selection range')
    previousEnd = value.end_line
    return { start_line: value.start_line, end_line: value.end_line }
  })
}

export const validateContextSelection = (raw: unknown, requestedPaths: string[], requestWarnings: string[] = []): ContextSelection => {
  const value = raw as ContextSelection
  if (!value || !Array.isArray(value.files) || value.files.length !== requestedPaths.length || !Array.isArray(value.warnings)) {
    throw new Error('Invalid local Laya context selection answer')
  }
  const files = value.files.map((file, index) => {
    const entry = file as ContextSelectionFile
    if (!entry || entry.path !== requestedPaths[index] || typeof entry.should_read !== 'boolean'
      || !Array.isArray(entry.ranges) || typeof entry.complete !== 'boolean' || !Array.isArray(entry.warnings)
      || !['laya', 'conservative-fallback'].includes(entry.source)) {
      throw new Error('Invalid local Laya context selection file')
    }
    if (entry.source === 'conservative-fallback') {
      if (!entry.should_read) {
        throw new Error('Invalid conservative context selection file')
      }
      if (entry.total_lines === null) {
        if (entry.ranges.length !== 0 || entry.complete) throw new Error('Invalid conservative context selection file')
        return conservativeContextSelection([entry.path], [...requestWarnings, ...safeWarnings(entry.warnings)]).files[0]
      }
      if (!Number.isInteger(entry.total_lines) || entry.total_lines < 0) throw new Error('Invalid conservative context selection total_lines')
      return {
        path: entry.path,
        should_read: true,
        ranges: validateContextRanges(entry.ranges, entry.total_lines),
        total_lines: entry.total_lines,
        complete: entry.complete,
        source: 'conservative-fallback' as const,
        warnings: [...requestWarnings, ...safeWarnings(entry.warnings)],
      }
    }
    if (!Number.isInteger(entry.total_lines) || (entry.total_lines as number) < 0) throw new Error('Invalid context selection total_lines')
    const ranges = validateContextRanges(entry.ranges, entry.total_lines as number)
    if (!entry.should_read && (!entry.complete || ranges.length !== 0)) throw new Error('Invalid context selection skip')
    return {
      path: entry.path,
      should_read: entry.should_read,
      ranges,
      total_lines: entry.total_lines as number,
      complete: entry.complete,
      source: 'laya' as const,
      warnings: [...requestWarnings, ...safeWarnings(entry.warnings)],
    }
  })
  return { files, warnings: [...requestWarnings, ...safeWarnings(value.warnings)] }
}

export const classifyLocal = async (task: string, phase: Phase = 'work'): Promise<Classification> => {
  const local = await ensureRuntime()
  if (local.state !== 'ready' || !local.python || !local.checkpoint) throw new Error(local.message)
  const result = spawnSync(local.python, pythonArgs(local.checkpoint), {
    input: JSON.stringify({ task, phase }), encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1_000_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
  })
  if (result.status !== 0) throw new Error('Local Laya inference failed; the original model was kept.')
  try { return validateClassification(JSON.parse(result.stdout), phase) }
  catch { throw new Error('Local Laya returned an invalid answer; the original model was kept.') }
}

export const shouldReadFileLocal = async (task: string, path: string, summary = '', excerpt = ''): Promise<FileRelevance> => {
  task = requireText('task', task, true)
  path = requireText('path', path, true)
  summary = requireText('summary', summary)
  excerpt = requireText('excerpt', excerpt)
  const { request, warnings } = boundedRelevanceRequest(task, path, summary, excerpt)
  try {
    const local = await ensureRuntime()
    if (local.state !== 'ready' || !local.python || !local.checkpoint) return conservativeFileRelevance(request.path, warnings)
    const result = spawnSync(local.python, pythonArgs(local.checkpoint), {
      input: JSON.stringify({ operation: 'should_read_file', ...request }), encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1_000_000,
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    })
    if (result.status !== 0) return conservativeFileRelevance(request.path, warnings)
    try { return validateFileRelevance(JSON.parse(result.stdout), request.path, warnings) }
    catch { return conservativeFileRelevance(request.path, warnings) }
  } catch {
    return conservativeFileRelevance(request.path, warnings)
  }
}

export const selectContextLocal = async (task: string, paths: string[], options: ContextSelectionOptions = {}): Promise<ContextSelection> => {
  const { request, warnings } = boundedContextSelectionRequest(task, paths, options)
  try {
    const local = await ensureRuntime()
    if (local.state !== 'ready' || !local.python || !local.checkpoint) return conservativeContextSelection(request.paths, warnings)
    const result = spawnSync(local.python, pythonArgs(local.checkpoint), {
      input: JSON.stringify({ operation: 'select_context', ...request }), encoding: 'utf8', timeout: (request.time_budget + CONTEXT_PROCESS_OVERHEAD_S) * 1000, windowsHide: true, maxBuffer: 2_000_000,
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    })
    if (result.status !== 0) return conservativeContextSelection(request.paths, warnings)
    try { return validateContextSelection(JSON.parse(result.stdout), request.paths, warnings) }
    catch { return conservativeContextSelection(request.paths, warnings) }
  } catch {
    return conservativeContextSelection(request.paths, warnings)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--install') await installRuntime()
