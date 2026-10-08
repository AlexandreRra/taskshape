// Engine-safe entry point: the Claude function hook invokes this process with stdin JSON.
import { readFileSync } from 'node:fs'
import { classifyLocal, ensureRuntime, installRuntime, selectContextLocal, shouldReadFileLocal } from './runtime.ts'
try {
  if (process.argv[2] === 'install') {
    await installRuntime()
    const status = await ensureRuntime()
    process.stdout.write(JSON.stringify(status))
    if (status.state !== 'ready') process.exitCode = 1
  } else if (process.argv[2] === 'prepare') process.stdout.write(JSON.stringify(await ensureRuntime()))
  else if (process.argv[2] === 'should-read-file') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(JSON.stringify(await shouldReadFileLocal(input.task, input.path, input.summary ?? '', input.excerpt ?? '')))
  }
  else if (process.argv[2] === 'select-context') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(JSON.stringify(await selectContextLocal(input.task, input.paths, {
      root: input.root,
      skip_threshold: input.skip_threshold,
      max_file_bytes: input.max_file_bytes,
      chunk_lines: input.chunk_lines,
      max_chunks: input.max_chunks,
      batch_size: input.batch_size,
    })))
  }
  else {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    if (typeof input.task !== 'string' || !['work', 'review'].includes(input.phase ?? 'work')) throw new Error('Invalid classification input')
    process.stdout.write(JSON.stringify(await classifyLocal(input.task, input.phase ?? 'work')))
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'Local Laya unavailable')
  process.exitCode = 1
}
