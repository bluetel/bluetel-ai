/**
 * Types for human-in-the-loop review requests.
 *
 * A review is created by an external agent (e.g. the Dify `request_review`
 * tool running inside a workflow loop), surfaced to a human in the admin
 * dashboard, and resolved with an approve/reject decision. The agent polls
 * the review until it reaches a terminal status.
 */

/** Lifecycle status of a review request. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** The two decisions a human reviewer can make. */
export type ReviewDecision = 'approved' | 'rejected'

/** Statuses from which no further transition is possible. */
export const TERMINAL_REVIEW_STATUSES: readonly ReviewStatus[] = ['approved', 'rejected', 'expired']

/** Input accepted when creating a review request. */
export interface ReviewInput {
  /** Short headline shown in the dashboard list (e.g. "Review PR #12 diff"). */
  title: string
  /** The material to review — code, diff, or markdown. */
  content: string
  /** Optional surrounding context (the task prompt, prior findings, etc.). */
  context?: string
  /** Optional repository the review relates to, as `owner/repo`. */
  repoFullName?: string
  /** Optional branch the review relates to. */
  branch?: string
  /** Optional loop iteration number, for multi-round review flows. */
  iteration?: number
  /** Optional free-form key/value metadata carried through to the reviewer. */
  metadata?: Record<string, string>
  /** Optional time-to-live in seconds before the review auto-expires. */
  ttlSeconds?: number
}

/** A review request record, as held in the store (dates as `Date`). */
export interface Review {
  id: string
  status: ReviewStatus
  title: string
  content: string
  context: string | null
  repoFullName: string | null
  branch: string | null
  iteration: number | null
  metadata: Record<string, string>
  /** The decision once resolved, or null while pending/expired. */
  decision: ReviewDecision | null
  /** Reviewer-supplied comment, empty until decided. */
  comment: string
  /** Identifier of the human who decided, empty until decided. */
  reviewer: string
  createdAt: Date
  updatedAt: Date
  decidedAt: Date | null
  /** When a pending review auto-expires, or null when it never expires. */
  expiresAt: Date | null
}

/** Result of attempting to decide a review. */
export type DecideOutcome =
  | { kind: 'ok'; review: Review }
  | { kind: 'not-found' }
  /** The review was already resolved (terminal) and cannot be re-decided. */
  | { kind: 'conflict'; review: Review }

/** In-memory store contract for review requests. */
export interface ReviewStore {
  create: (input: ReviewInput) => Review
  get: (id: string) => Review | undefined
  getAll: () => Review[]
  decide: (id: string, decision: ReviewDecision, comment: string, reviewer: string) => DecideOutcome
  /** Marks pending reviews whose `expiresAt` has passed as `expired`. */
  expireOverdue: (now?: Date) => number
}
