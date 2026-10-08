// SubagentStop hook: records the outcome of the routed launch. Copilot CLI sends `{ sessionId, agentType,
// stopReason, response }`; VS Code's agent mode sends `{ session_id, agent_id, agent_type, stop_hook_active }`
// and exposes no stop reason, so acceptance stays unknown (null) there.
import { readFileSync } from 'node:fs'
import { type Harness, appendLine, dataDir, dataPaths, ensureConfig, popPending } from './harness.ts'

type StopInput = {
  sessionId?: string; agentId?: string; agentType?: string; agentName?: string; stopReason?: string
  session_id?: string; agent_id?: string; agent_type?: string; stop_hook_active?: boolean
}

const main = () => {
  let input: StopInput
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as StopInput
  } catch {
    return
  }
  const harness: Harness = typeof input.session_id === 'string' || typeof input.agent_id === 'string' ? 'vscode-local'
    : typeof input.sessionId === 'string' ? 'copilot-cli' : 'unknown'
  if (harness === 'unknown') return
  const paths = dataPaths(dataDir())
  ensureConfig(paths.config)
  const sessionId = input.session_id ?? input.sessionId
  const agentType = input.agentType ?? input.agent_type
  const match = popPending(paths.pending, sessionId, harness, { agentId: input.agent_id, agentName: input.agentName, agentType })
  if (!match) return
  if (!match.row) {
    // several launches fit this stop and nothing tells them apart: say so instead of crediting the wrong profile
    appendLine(paths.decisions, { ts: Date.now() / 1000, origin: harness === 'vscode-local' ? 'vscode-plugin' : 'copilot-plugin', harness,
      mode: 'skipped', why: 'outcome not attributed: several pending launches fit this stop', sessionId: sessionId ?? null })
    return
  }
  const decision = match.row
  const started = typeof decision.ts === 'number' ? decision.ts : undefined
  const now = Date.now() / 1000
  const enforced = decision.mode === 'enforced'
  const row = { ts: now, task_sha256: null, origin: decision.origin ?? (harness === 'vscode-local' ? 'vscode-plugin' : 'copilot-plugin'), harness,
    shape: decision.shape ?? null,
    // in suggest mode the profile was never run: keep it apart so no report credits it with this result
    profile: enforced ? decision.profile ?? null : null, suggested_profile: enforced ? null : decision.profile ?? null,
    model: enforced ? decision.model : 'inherited', effort: enforced ? decision.effort : 'default',
    accepted: harness === 'copilot-cli' ? input.stopReason === 'end_turn' : null,
    outcome: decision.mode ?? null, stop_reason: input.stopReason ?? null, stop_hook_active: input.stop_hook_active ?? null,
    agent_type: agentType ?? null, input_tokens: null, output_tokens: null,
    seconds: started ? Math.round((now - started) * 10) / 10 : null, cost_usd: null }
  appendLine(paths.outcomes, row)
}

try {
  main()
} catch {
  // best effort
}
