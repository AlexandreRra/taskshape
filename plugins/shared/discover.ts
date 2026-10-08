// Model discovery through the Copilot CLI's ACP server (`copilot --acp`): `initialize` then `session/new` answer with the
// account's models, their display names and usage multipliers, without any model call. Best effort: any failure yields
// a catalog without models, which leaves the shipped profile table in charge. The server exits on stdin EOF (about
// 0.7 s after answering); the process group is killed as well in case it does not.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import { type Catalog, type Config, acquireLock, catalogFresh, parseAcpModels, readCatalog, releaseLock, writeCatalog } from './harness.ts'

export type DiscoverOptions = { command?: string; cwd?: string; timeoutMs?: number }

export const DISCOVERY_TIMEOUT_MS = 7000

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } }

export type SpawnEnv = { platform?: string; path?: string; pathext?: string; comspec?: string; exists?: (file: string) => boolean }
export type SpawnPlan = { command: string; args: string[]; windowsVerbatimArguments?: boolean }

const isFile = (file: string): boolean => {
  try { return existsSync(file) && statSync(file).isFile() } catch { return false }
}

/**
 * How to start `command args` without `shell: true`. Elsewhere the command is spawned as is. On Windows it is resolved the way
 * the shell would (PATH, then PATHEXT): an .exe/.com runs directly; an npm-style .cmd/.bat shim cannot be spawned without a
 * shell (Node refuses it), so it runs through `cmd.exe /d /s /c` with the path quoted and the arguments passed verbatim.
 * Returns an error text for a name that cannot be quoted safely for cmd.exe.
 */
export const resolveSpawn = (command: string, args: string[], env: SpawnEnv = {}): SpawnPlan | { error: string } => {
  const platform = env.platform ?? process.platform
  if (platform !== 'win32') return { command, args }
  const exists = env.exists ?? isFile
  const exts = (env.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasDir = /[\\/:]/.test(command)
  const dirs = hasDir ? [''] : (env.path ?? process.env.PATH ?? '').split(';').filter(Boolean)
  const names = exts.some(ext => command.toLowerCase().endsWith(ext.toLowerCase())) ? [command, ...exts.map(ext => command + ext)] : exts.map(ext => command + ext)
  let found: string | undefined
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? win32.join(dir, name) : name
      if (exists(candidate)) { found = candidate; break }
    }
    if (found) break
  }
  if (!found) return { command, args } // let spawn report ENOENT
  if (!/\.(cmd|bat)$/i.test(found)) return { command: found, args }
  if (/["%^&|<>\r\n]/.test(found) || args.some(arg => !/^[\w.=:/\\-]+$/.test(arg))) return { error: `${found}: cannot be started through cmd.exe safely` }
  return { command: env.comspec ?? process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[found, ...args].map(part => `"${part}"`).join(' ')}"`], windowsVerbatimArguments: true }
}

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
    const plan = resolveSpawn(command, ['--acp'])
    if ('error' in plan) {
      finish({}, plan.error)
      return
    }
    child = spawn(plan.command, plan.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32', windowsVerbatimArguments: plan.windowsVerbatimArguments, windowsHide: true })
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
