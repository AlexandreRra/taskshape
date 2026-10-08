// SessionStart hook (Copilot CLI `sessionStart` and VS Code `SessionStart`): writes the default config file on the
// first run, so installing the plugin is the whole setup, prunes stale session/pending files, and refreshes the
// account's model catalog through the Copilot CLI when the cached one is older than a day. In VS Code's agent mode
// the payload `{ session_id, source, model, agent_type }` also names the session's main model, which is remembered
// so PreToolUse can respect VS Code's rule that a sub-agent may not use a model with a higher usage multiplier than
// the main one. Payloads without a model (the Copilot CLI's) only trigger the housekeeping.
import { readFileSync } from 'node:fs'
import { DEFAULT_CONFIG, dataDir, dataPaths, ensureConfig, parseConfig, pruneDir, readJson, rememberSessionModel } from './harness.ts'
import { refreshCatalog } from './discover.ts'

const WEEK = 7 * 24 * 3600

type RuntimeStatus = { state: 'installing' | 'ready' | 'error'; message: string; python?: string; checkpoint?: string }

const ensureLayaRuntime = async (): Promise<RuntimeStatus> => {
  const runtime = await import('./runtime.ts') as { ensureRuntime: () => Promise<RuntimeStatus> }
  return runtime.ensureRuntime()
}

const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 200)

const runtimeStatusLine = (status: RuntimeStatus): string =>
  `taskshape runtime ${status.state}: ${status.message}`

const vscodeContext = (message: string): string => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
})

const main = async () => {
  const dir = dataDir()
  const paths = dataPaths(dir)
  ensureConfig(paths.config)
  pruneDir(paths.sessions, WEEK)
  pruneDir(paths.pending, WEEK)
  let input: { session_id?: unknown; model?: unknown } = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    // housekeeping still applies
  }
  if (typeof input.session_id === 'string' && typeof input.model === 'string' && input.model) {
    rememberSessionModel(paths.sessions, input.session_id, input.model)
  }
  const config = parseConfig(readJson(paths.config) ?? DEFAULT_CONFIG, process.env)
  if (config.backend === 'laya' && !config.command) {
    let status: RuntimeStatus
    try {
      status = await ensureLayaRuntime()
    } catch (error) {
      status = { state: 'error', message: `laya unavailable: ${errorText(error)}` }
    }
    const line = runtimeStatusLine(status)
    process.stderr.write(line + '\n')
    if (typeof input.session_id === 'string') process.stdout.write(vscodeContext(line))
  }
  await refreshCatalog(paths, config, dir)
}

main().catch(() => {
  // best effort
})
