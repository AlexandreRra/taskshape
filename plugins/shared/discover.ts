// Model discovery through the Copilot CLI's ACP server (`copilot --acp`): `initialize` then `session/new` answer with the
// account's models, their display names and usage multipliers, without any model call. Best effort: any failure yields
// a catalog without models, which leaves the shipped profile table in charge. The server exits on stdin EOF (about
// 0.7 s after answering); the process group is killed as well in case it does not.
import { spawn, type ChildProcess } from 'node:child_process'
import { type Catalog, type Config, acquireLock, catalogFresh, parseAcpModels, readCatalog, releaseLock, writeCatalog } from './harness.ts'

export type DiscoverOptions = { command?: string; cwd?: string; timeoutMs?: number }

export const DISCOVERY_TIMEOUT_MS = 7000

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } }

export const discoverModels = (opts: DiscoverOptions = {}): Promise<Catalog> => new Promise(resolve => {
  const command = opts.command || 'copilot'
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  const ts = Date.now() / 1000
  let settled = false
  let child: ChildProcess | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const kill = () => {
    try {
      if (child?.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child?.kill()
    } catch {
      // already gone
    }
  }
  const finish = (models: Catalog['models'], error?: string) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    resolve({ ts, source: 'copilot-acp', models, ...(error ? { error: error.slice(0, 200) } : {}) })
  }
  timer = setTimeout(() => { kill(); finish({}, `${command} --acp did not answer within ${timeoutMs} ms`) }, timeoutMs)
  try {
    child = spawn(command, ['--acp'], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32', shell: process.platform === 'win32', windowsHide: true })
  } catch (error) {
    finish({}, String(error))
    return
  }
  child.on('error', error => finish({}, `${command}: ${error.message}`))
  child.on('exit', (code, signal) => finish({}, `${command} --acp exited (${code ?? signal}) before answering`))
  child.stdin?.on('error', () => { /* closed early */ })
  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer | string) => {
    buffer += String(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message: { id?: unknown; result?: unknown; error?: unknown }
      try { message = JSON.parse(line) } catch { continue }
      if (message.id !== 2) continue
      if (message.result) finish(parseAcpModels(message.result))
      else finish({}, `session/new failed: ${JSON.stringify(message.error ?? null)}`)
      try { child?.stdin?.end() } catch { /* ignore */ }
      setTimeout(kill, 1500).unref()
      child?.unref()
    }
  })
  child.stdin?.write(JSON.stringify(INITIALIZE) + '\n')
  child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: opts.cwd ?? process.cwd(), mcpServers: [] } }) + '\n')
})

/**
 * The catalog to route with: the cached one while it is fresh, otherwise a new discovery (one at a time, lock file).
 * A failed refresh keeps the previously discovered models and notes the error, so the retry comes sooner.
 */
const discoveryTimeout = (): number => {
  const fromEnv = Number(process.env.TASKSHAPE_DISCOVERY_TIMEOUT_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DISCOVERY_TIMEOUT_MS
}

export const refreshCatalog = async (paths: { catalog: string; lock: string }, config: Config, cwd: string, timeoutMs = discoveryTimeout()): Promise<Catalog | undefined> => {
  const current = readCatalog(paths.catalog)
  if (!config.discoverModels || catalogFresh(current)) return current
  if (!acquireLock(paths.lock)) return current
  try {
    const found = await discoverModels({ command: config.copilot, cwd, timeoutMs })
    const next: Catalog = found.error && current && Object.keys(current.models).length > 0
      ? { ...current, ts: found.ts, error: found.error }
      : found
    writeCatalog(paths.catalog, next)
    return next
  } finally {
    releaseLock(paths.lock)
  }
}
