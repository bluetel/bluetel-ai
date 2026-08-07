import { createEnumGuard } from './enum-guard'

/**
 * The allowlist of model identifiers a profile may launch with (research.md R15).
 *
 * These are **exact ids, used as written, with no date suffix appended**. A free-text model string
 * becomes a 404 at run time, on a paid instance, after bootstrap has already completed; an
 * allowlist turns that into a validation error at profile-enable time instead.
 *
 * Adding a model is deliberately a reviewed change: a Postgres enum migration plus an edit here,
 * because model choice drives both cost and capability.
 */
export const CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-fable-5',
] as const

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]

export const isClaudeModel = createEnumGuard(CLAUDE_MODELS)

/** The model a profile gets if it does not name one (research.md R15). */
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5'
