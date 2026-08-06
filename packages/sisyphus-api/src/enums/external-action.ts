import { createEnumGuard } from './enum-guard'

/**
 * What a run did outside the platform, and how it went (FR-076, FR-077).
 *
 * Kind and result are one vocabulary in two halves because they are only ever recorded together:
 * an external action row without a result is not a partial record, it is a record of an attempt.
 */

/** The kinds of action that leave a mark somewhere a customer can see. */
export const EXTERNAL_ACTION_KINDS = [
  'pull_request_opened',
  'comment_posted',
  'ticket_transitioned',
  'branch_pushed',
] as const

export type ExternalActionKind = (typeof EXTERNAL_ACTION_KINDS)[number]

export const isExternalActionKind = createEnumGuard(EXTERNAL_ACTION_KINDS)

/**
 * How the attempt ended.
 *
 * `pending` is here and not only in the database because an action is recorded **before** it is
 * known to have landed — that is what makes the idempotency key useful on a retry rather than a
 * second comment being posted.
 */
export const EXTERNAL_ACTION_RESULTS = ['succeeded', 'failed', 'pending'] as const

export type ExternalActionResult = (typeof EXTERNAL_ACTION_RESULTS)[number]

export const isExternalActionResult = createEnumGuard(EXTERNAL_ACTION_RESULTS)
