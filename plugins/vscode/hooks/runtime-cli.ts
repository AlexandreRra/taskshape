// Engine-safe entry point: the Claude function hook invokes this process with stdin JSON.
import { readFileSync } from 'node:fs'
import { classifyLocal, ensureRuntime, installRuntime } from './runtime.ts'
try {
  if (process.argv[2] === 'install') {
    await installRuntime()
    const status = await ensureRuntime()
    process.stdout.write(JSON.stringify(status))
    if (status.state !== 'ready') process.exitCode = 1
  } else if (process.argv[2] === 'prepare') process.stdout.write(JSON.stringify(await ensureRuntime()))
  else {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    if (typeof input.task !== 'string' || !['work', 'review'].includes(input.phase ?? 'work')) throw new Error('Invalid classification input')
    process.stdout.write(JSON.stringify(await classifyLocal(input.task, input.phase ?? 'work')))
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'Local Laya unavailable')
  process.exitCode = 1
}
