// Transparent keyword rubric, a port of src/taskshape/rubric.py: the plugin's built-in classifier when no
// Python taskshape is installed. Cited sources and negated clauses are stripped before looking for
// coupled or architecture cues, so "applies RFC-7" or "no schema changes" cannot escalate a brief.
import { type Phase, type Shape, shapesFor } from './shapes.ts'

// Only the reference itself is removed ("per the migration guide", "RFC-7", "§4.2"), never the rest of the sentence.
const CITED = /(?:\b(?:(?:applies|applying|conforms? to|cites?|cited|per|see|according to)\s+(?:the\s+)?(?:[\w-]+\s+)?(?:spec|specification|rfc|adr|docs?|documentation|guide|ticket|section)\b|rfc[- ]?\d+\b)|§\s*[\d.]+)/gi
const NEGATED_AFTER = /\b(no|not|never|without|cannot|must not|do not|does not|don't)\b[^.;,\n]{0,60}/gi
const NEGATED_BEFORE = /[^.;,\n]{0,40}\b(untouched|unchanged|unaffected|out of scope|preserved|as is)\b/gi

export const ROLE_HINTS: Record<string, Shape | null> = {
  lookup: 'lookup', explore: 'routine', executor: null, 'executor-complex': 'coupled', debugger: 'coupled',
  'test-engineer': null, planner: 'architecture', architect: 'architecture', analyst: 'architecture',
  critic: 'architecture', 'code-reviewer': 'review', verifier: 'review', 'security-reviewer': 'review',
  designer: 'visual', vision: 'visual',
}

const CUES = {
  // matched on the cleaned text
  architecture: /\b(plan|write|author|draft|produce|own)\b[^.;]{0,60}\b(prd|spec|specification|rfc|adr|design doc)\b|\barchitecture\b|\barchitect\b|design (decision|review|approach)|tradeoffs?|dispute|requirements? analysis|roadmap|milestone plan/i,
  coupled: /persist|schema|migration|serializ|\breplay\b|data loss|corrupt|idempoten|transaction|concurren|\brace\b|thread|deadlock|\block(s|ed|ing)?\b|security|authori[sz]\w*|authent\w*|\bauthn\b|\bauthz\b|\boauth\d*\b|\bauth\b|permission|several (files|systems|services)|cross-service|coupled|high[- ]risk|root[- ]cause|diagnos|hypothes[ie]s|regression (isolation|strategy)|duplicate[d]? (rewards?|charges?|events?)/i,
  escalation: /two (unsuccessful|failed|materially)|third attempt|escalat|second independent review|disput/i,
  visual: /screenshot|mockup|wireframe|pixel[- ]art|sprite|visual (review|design|polish)|layout review|asset review|\bui design\b|figma|png\b/i,
  // matched on the raw text
  demanding_strong: /not (yet )?(confirmed|known|proven)|unproven|unconfirmed|red\/green|live oracle|build an? oracle|reproduce|several steps|multi-step|end[- ]to[- ]end|all controls reachable|runtime regression|performance/i,
  demanding: /captures?\b|rendered|smoke|integration test|refactor|implement (the|a) \w+ feature|feature\b|debug\b/i,
  routine: /test-only|docs-only|no code edits|no production edits|wording|\blabel\b|contrast|\bdocs?\b|readme|changelog|backlog|rename|typo|append|register the|fixture|synced|assertion for|list (the|every)|summarize|split the|config (tweak|change)|bump|lint|format/i,
  lookup: /\bfind (the )?(exact|string|file|line)|\bgrep\b|locate the (file|string|definition)|where is\b|which file\b|exact (file|string) lookup/i,
} as const

type Cue = keyof typeof CUES
const CLEANED: readonly Cue[] = ['architecture', 'coupled', 'escalation', 'visual']

export const cleanText = (text: string): string =>
  text.replace(CITED, ' ').replace(NEGATED_BEFORE, ' ').replace(NEGATED_AFTER, ' ')

export const features = (text: string): Record<Cue, boolean> => {
  const raw = text.toLowerCase()
  const cleaned = cleanText(text).toLowerCase()
  const found = {} as Record<Cue, boolean>
  for (const name of Object.keys(CUES) as Cue[]) {
    found[name] = CUES[name].test(CLEANED.includes(name) ? cleaned : raw)
  }
  return found
}

export const classify = (text: string, phase: Phase = 'work', role?: string): Shape => {
  const allowed = shapesFor(phase)
  const hint = role ? ROLE_HINTS[role] ?? undefined : undefined
  const found = features(text)
  if (phase === 'review') {
    if (hint === 'architecture' || found.escalation || found.architecture) return 'architecture'
    return 'review'
  }
  if (hint === 'lookup' || (found.lookup && !found.coupled && !found.architecture)) return 'lookup'
  if (hint === 'architecture' || found.escalation) return 'architecture'
  if (hint === 'routine') return 'routine'
  if (found.architecture && !found.routine) return 'architecture'
  if (hint === 'visual' || found.visual) return allowed.includes('visual') ? 'visual' : 'demanding'
  if (hint === 'coupled' || found.coupled) return 'coupled'
  if (found.demanding_strong) return 'demanding'
  if (found.routine) return 'routine'
  if (found.demanding) return 'demanding'
  return 'routine'
}
