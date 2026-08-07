import { createEnumGuard } from './enum-guard'

/**
 * The closed set of outcomes a workflow can reach, **verbatim from FR-064**.
 *
 * Do not extend, rename or reorder casually: all three apps derive their vocabulary from this
 * tuple, so a change here is a Postgres enum migration as well as a code change.
 *
 * - `succeeded` — the run finished the work it was given.
 * - `failed` — the run ended without finishing, for a recorded reason.
 * - `capped` — the run hit its turn or spend cap and stopped (FR-055).
 * - `cancelled` — a human pressed Stop; this is where FR-049's Stop lands and it must never be
 *   counted as a failure.
 * - `needs_attention` — the run stopped and a human has to look at it.
 * - `parked_resumable` — a snapshot is persisted and compute released while the run waits on a
 *   human. Recorded as an outcome so the FR-064 "exactly one outcome" and SC-006 reconciliation
 *   clocks both hold, but not absorbing: FR-151 resumes the same workflow out of it.
 */
export const TERMINAL_OUTCOMES = [
  'succeeded',
  'failed',
  'capped',
  'cancelled',
  'needs_attention',
  'parked_resumable',
] as const

export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number]

export const isTerminalOutcome = createEnumGuard(TERMINAL_OUTCOMES)
