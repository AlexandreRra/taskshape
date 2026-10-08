// Preload for `node --import`: resolves the engine-only module 'claude-code/testing' to the local shim.
import { register } from 'node:module'

register('./resolve.mjs', import.meta.url)
