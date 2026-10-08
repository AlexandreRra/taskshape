// Provisioned locally on first use. Classification never sends task text over the network.
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { shapesFor, type Phase, type Shape } from './shapes.ts'

export type RuntimeStatus = { state: 'installing' | 'ready' | 'error'; message: string; python?: string; checkpoint?: string; updated?: number }
export type Classification = { shape: Shape; answer_confidence: number; shape_probabilities: Record<string, number>; source: 'laya' }
type Artifact = { url: string; sha256: string; path?: string; size?: number; executable?: string }
type Assets = { version: number; python: string; uv: Record<string, Artifact>; model: { revision: string; files: Artifact[] } }

const here = dirname(fileURLToPath(import.meta.url))
export const bundledRuntime = (): string => [join(here, '..', 'runtime'), join(here, '..', '..', 'runtime')]
  .find(path => existsSync(join(path, 'assets.json'))) ?? join(here, '..', 'runtime')
const payload = (): string => createHash('sha256').update(readFileSync(join(bundledRuntime(), 'assets.json')))
  .update(readFileSync(join(bundledRuntime(), 'requirements.lock'))).digest('hex').slice(0, 16)
export const runtimeDir = (): string => join(process.env.TASKSHAPE_HOME || join(homedir(), '.taskshape'), 'runtime', payload())
const statusPath = (): string => join(runtimeDir(), 'status.json')
const lockOwnerAlive = (): boolean => {
  const lock = join(runtimeDir(), 'install.lock')
  try {
    const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'))
    if (!Number.isInteger(pid) || pid < 1) return false
    process.kill(pid, 0)
    return true
  } catch {
    // Allow the installer a moment to write its PID after acquiring the lock.
    try { return Date.now() - statSync(lock).mtimeMs < 5_000 } catch { return false }
  }
}

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
    && existsSync(current.python) && existsSync(join(current.checkpoint, 'rl_agent_config.json'))) return current
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
      ? ` Exit ${result.status ?? 'signal'} on ${process.platform}/${process.arch}. stdout: ${result.stdout.slice(-2_000)} stderr: ${result.stderr.slice(-2_000)}`
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
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
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
    const check = spawnSync(python, ['-I', join(bundledRuntime(), 'classify.py'), checkpoint], {
      env: { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
      input: JSON.stringify({ task: 'Find the filename that contains the exact setting name.', phase: 'work' }), encoding: 'utf8', timeout: 60_000, windowsHide: true,
    })
    if (check.status !== 0) throw new Error('Laya was downloaded but its local inference check failed.')
    validateClassification(JSON.parse(check.stdout), 'work')
    saveStatus({ state: 'ready', message: 'Taskshape: local Laya is ready.', python, checkpoint })
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

export const classifyLocal = async (task: string, phase: Phase = 'work'): Promise<Classification> => {
  const local = await ensureRuntime()
  if (local.state !== 'ready' || !local.python || !local.checkpoint) throw new Error(local.message)
  const result = spawnSync(local.python, ['-I', join(bundledRuntime(), 'classify.py'), local.checkpoint], {
    input: JSON.stringify({ task, phase }), encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1_000_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
  })
  if (result.status !== 0) throw new Error('Local Laya inference failed; the original model was kept.')
  try { return validateClassification(JSON.parse(result.stdout), phase) }
  catch { throw new Error('Local Laya returned an invalid answer; the original model was kept.') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--install') await installRuntime()
