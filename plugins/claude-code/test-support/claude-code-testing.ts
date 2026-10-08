// A local stand-in for the engine's 'claude-code/testing' kit, so the plugin's *.test.ts files also run under plain
// `node --test` (CI, no claude CLI). It covers only what those tests use: describe, test (with options), expect, and a `$`
// over the plugin's real register(). `claude plugin test` stays the reference runner.
import { AssertionError } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe as nodeDescribe, test as nodeTest } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Json = Record<string, unknown>
type Hook = (...args: any[]) => unknown
type Registered = { pattern: string; matcher?: Json; hook: Hook }
type Next = (e: any) => Promise<any>
type Dispatch = (event: string, e: any) => Promise<any>

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8')) as { name: string; userConfig?: Record<string, Json> }
const hooksModules = (JSON.parse(readFileSync(resolve(root, 'hooks/hooks.json'), 'utf8')) as { modules: string[] }).modules

const selects = (pattern: string, event: string) =>
  pattern === '*' || pattern === event || (pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1)))

const matches = (matcher: Json | undefined, e: Json) => !matcher || Object.entries(matcher).every(([key, want]) =>
  Array.isArray(want) ? want.includes(e[key]) : want instanceof RegExp ? want.test(String(e[key])) : e[key] === want)

// Defaults filled in and values checked against the manifest, as a plugin load does.
const pluginOptions = (given: Json = {}): Json => {
  const values: Json = {}
  for (const [key, spec] of Object.entries(manifest.userConfig ?? {})) {
    const value = key in given ? given[key] : spec.default
    if (value === undefined) continue
    if (typeof value !== spec.type) throw new Error(`option ${key} must be a ${spec.type}`)
    if (Array.isArray(spec.options) && !spec.options.includes(value)) throw new Error(`option ${key} must be one of ${spec.options.join(', ')}`)
    values[key] = value
  }
  for (const key of Object.keys(given)) if (!(key in values)) throw new Error(`option ${key} is not declared in plugin.json`)
  return values
}

// Chain of the hooks selected by `event`, the plugin's first (outermost); below the last one is the bottom.
const chainFor = (layers: Registered[][], event: string, plugin$: () => any): Dispatch => {
  const run = (hooks: Registered[], index: number, e: any): Promise<any> => {
    const hook = hooks[index]
    if (!hook) return Promise.reject(new Error(`no hook answers ${event}`))
    const next: Next = (nextEvent) => run(hooks, index + 1, nextEvent)
    return Promise.resolve(hook.hook(plugin$(), e, next)).then(result => {
      if (result === undefined) throw new Error(`a hook on ${event} returned nothing`)
      return result
    })
  }
  const hooks = layers.flat().filter(r => selects(r.pattern, event))
  return (_event, e) => run(hooks.filter(r => matches(r.matcher, e)), 0, e)
}

// The nouns hooks call on `$`: each is an event carrying the call's arguments; a `{ deny }` answer rejects the caller.
const nouns = (dispatch: Dispatch) => {
  const call = async (event: string, e: Json) => {
    const answer = await dispatch(event, e)
    if (answer.deny !== undefined) throw new Error(answer.deny)
    return answer.value
  }
  return {
    env: { get: (name: string) => call('env.get', { name }) },
    fs: {
      exists: (path: string) => call('fs.exists', { path }),
      read: (path: string, init: Json = {}) => call('fs.read', { path, as: 'text', ...init }),
      write: (path: string, text: string) => call('fs.write', { path, text }),
    },
    process: { run: (argv: readonly string[], init?: Json) => call('process.run', init ? { argv, init } : { argv }) },
    ui: { status: (text: string) => call('ui.status', { text }), toast: (text: string) => call('ui.toast', { text }) },
  }
}

const runTest = async (options: Json, body: (...args: any[]) => unknown) => {
  const own: Registered[] = []
  const beneath: Registered[] = []
  const registrar = (into: Registered[]) => (pattern: string, ...rest: unknown[]) => {
    const hook = rest.pop() as Hook
    const registration = { pattern, matcher: rest[0] as Json | undefined, hook }
    into.push(registration)
    return registration
  }
  const dispatchers = new Map<string, Dispatch>()
  const dispatch: Dispatch = (event, e) => {
    if (event === 'ui.status' || event === 'ui.toast') { // core answers these; a test may still hook them
      if (!beneath.some(r => selects(r.pattern, event))) return Promise.resolve({ value: undefined })
    }
    if (!dispatchers.has(event)) dispatchers.set(event, chainFor([own, beneath], event, () => engine))
    return dispatchers.get(event)!(event, e)
  }
  const engine: any = {
    ...nouns(dispatch),
    plugin: { name: manifest.name, root },
    tool: { call: (input: Json) => dispatch('tool.call', input) },
  }
  const opts = pluginOptions(options.options as Json | undefined)
  for (const file of hooksModules) {
    const loaded = await import(pathToFileURL(resolve(root, 'hooks', file)).href)
    loaded.register(registrar(own), opts)
  }
  return body(engine, registrar(beneath))
}

export const describe = (name: string, body: () => void): void => { nodeDescribe(name, body) }

export const test = (name: string, ...rest: unknown[]): void => {
  const body = rest.pop() as (...args: any[]) => unknown
  const options = (rest[0] ?? {}) as Json
  if (options.plugins) throw new Error('test shim: inline plugins are not supported')
  nodeTest(name, { timeout: typeof options.timeoutMs === 'number' ? options.timeoutMs : 5000 }, () => runTest(options, body))
}

const show = (value: unknown) => { try { return JSON.stringify(value) ?? String(value) } catch { return String(value) } }

// Jest's toEqual: recursive, and a property holding undefined equals an absent one.
const equals = (a: any, b: any): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => equals(item, b[index]))
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every(key => equals(a[key], b[key]))
}

const throwsAs = (error: any, expected: unknown): boolean => {
  if (expected === undefined) return true
  if (typeof expected === 'string') return String(error?.message).includes(expected)
  if (expected instanceof RegExp) return expected.test(String(error?.message))
  if (typeof expected === 'function') return error instanceof expected
  return String(error?.message) === (expected as { message: string }).message
}

const matchers = (actual: any) => ({
  toBe: (expected: unknown) => [Object.is(actual, expected), `to be ${show(expected)}`],
  toEqual: (expected: unknown) => [equals(actual, expected), `to equal ${show(expected)}`],
  toContain: (item: unknown) => [typeof actual === 'string' ? actual.includes(String(item)) : Array.from(actual).includes(item), `to contain ${show(item)}`],
  toMatch: (pattern: string | RegExp) => [typeof pattern === 'string' ? String(actual).includes(pattern) : pattern.test(String(actual)), `to match ${String(pattern)}`],
  toBeUndefined: () => [actual === undefined, 'to be undefined'],
  toThrow: (expected?: unknown) => {
    try { actual(); return [false, 'to throw'] } catch (error) { return [throwsAs(error, expected), `to throw ${show(expected)}`] }
  },
}) as Record<string, (...args: any[]) => [boolean, string]>

export const expect = (actual: unknown) => {
  const build = (negate: boolean) => Object.fromEntries(Object.keys(matchers(actual)).map(name => [name, (...args: unknown[]) => {
    const [passed, what] = matchers(actual)[name](...args)
    if (passed === negate) throw new AssertionError({ message: `expected ${show(actual)} ${negate ? 'not ' : ''}${what}`, actual, operator: name })
  }]))
  return { ...build(false), not: build(true) } as Record<string, (...args: any[]) => void> & { not: Record<string, (...args: any[]) => void> }
}
