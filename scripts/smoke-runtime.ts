// Run on a fresh home without relying on a system Python or an existing model cache.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { classifyLocal, ensureRuntime, installRuntime } from '../plugins/vscode/hooks/runtime.ts'

assert.ok(process.env.TASKSHAPE_HOME, 'Use an isolated TASKSHAPE_HOME for the installation smoke test')
process.env.TASKSHAPE_DEBUG_INSTALL = '1'
const launcher = process.platform === 'win32'
  ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'plugins/vscode/hooks/launch.ps1']
  : ['sh', 'plugins/vscode/hooks/launch.sh']
const started = spawnSync(launcher[0], [...launcher.slice(1), 'runtime-cli.ts', 'prepare'], {
  env: { ...process.env, TASKSHAPE_FORCE_BUNDLED_NODE: '1', TASKSHAPE_REQUIRE_BUNDLED_NODE: '1' }, encoding: 'utf8', timeout: 15_000,
})
assert.equal(started.status, 0, started.stderr)
assert.ok(started.stdout.trim(), started.stderr || 'Bundled Node launcher produced no status JSON')
assert.ok(['ready', 'installing'].includes(JSON.parse(started.stdout).state), 'Bundled Node must start the Laya runtime')
await installRuntime()
let status = await ensureRuntime()
const deadline = Date.now() + 25 * 60_000
while (status.state === 'installing' && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 3_000))
  status = await ensureRuntime()
}
assert.equal(status.state, 'ready', status.message)
assert.ok(status.python?.startsWith(resolve(process.env.TASKSHAPE_HOME)))
assert.ok(status.checkpoint?.startsWith(resolve(process.env.TASKSHAPE_HOME)))
// The installed state must work without the Node downloader or a Hugging Face online session.
globalThis.fetch = async () => { throw new Error('Network use after setup') }
for (const task of [
  'Find the source filename containing the exact configuration key.',
  'Corrija a vulnerabilidade que permite acessar os dados privados de outro usuário.',
  'Área de login: corrigir Índice', // accented capitals must survive the stdin round trip to Python
]) {
  const started = performance.now()
  const answer = await classifyLocal(task)
  assert.equal(answer.source, 'laya')
  process.stdout.write(JSON.stringify({ language: task.startsWith('Find') ? 'en' : 'pt', shape: answer.shape,
    confidence: answer.answer_confidence, seconds: Math.round((performance.now() - started) / 10) / 100 }) + '\n')
}
