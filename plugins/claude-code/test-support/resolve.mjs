// Module customization hook: only 'claude-code/testing' is redirected; everything else resolves as usual.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'claude-code/testing') return { url: new URL('./claude-code-testing.ts', import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
