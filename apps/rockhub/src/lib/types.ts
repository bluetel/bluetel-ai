// Shared TypeScript types for Rockhub.
//
// This module defines the cross-cutting types that flow through the
// pipeline: from a raw GitHub webhook delivery → an Event_Filter
// decision → a Trigger_Mention on the Mention_Queue → an OpenclawInvocation
// envelope serialized to the spawned subagent.
//
// Types are kept structural and library-agnostic so that the rest of the
// codebase can depend on `lib/types` without pulling in Octokit, pino, or
// Express type surface.

// ── Source Type ────────────────────────────────────────────────────

/**
 * The seven categories of GitHub events that Rockhub treats as a
 * Trigger_Source. Every Trigger_Mention is tagged with exactly one of
 * these values; every downstream component (Eyes_Reactor endpoint
 * mapping, Mention_Identity composition, Openclaw_Spawner envelope)
 * dispatches off this discriminator.
 */
export type SourceType =
  | 'issue_body'
  | 'issue_assignment'
  | 'issue_comment'
  | 'pr_body'
  | 'pr_comment'
  | 'pr_review_comment'
  | 'pr_review_request'

// ── Mention Identity ───────────────────────────────────────────────

/**
 * A stable string identifier for a Trigger_Mention used as the
 * deduplication key on the Mention_Queue's Processed_Set.
 *
 * Format: `${repoFullName}:${sourceType}:${sourceId}`. The `sourceId`
 * shape varies per `sourceType` — see the table in the design document.
 * For `pr_review_request`, the sourceId is itself colon-separated
 * (`{pr_number}:{reviewer_user_id}`), so a Mention_Identity for that
 * source has four colon-separated segments rather than three.
 */
export type MentionIdentity = string

/**
 * The structured components a Mention_Identity is composed from.
 * `composeIdentity` joins these into the canonical string form;
 * `parseIdentity` is its inverse.
 */
export interface MentionIdentityComponents {
  repoFullName: string
  sourceType: SourceType
  /**
   * Source-type-specific id. Shapes:
   *   - `issue_body`        → `{issue_number}`
   *   - `issue_assignment`  → `{issue_number}`
   *   - `issue_comment`     → `{comment_id}`
   *   - `pr_body`           → `{pr_number}`
   *   - `pr_comment`        → `{comment_id}`
   *   - `pr_review_comment` → `{comment_id}`
   *   - `pr_review_request` → `{pr_number}:{reviewer_user_id}`
   */
  sourceId: string
}

// ── Trigger Mention ────────────────────────────────────────────────

/**
 * The result of running the Event_Filter on a RawWebhookEvent (or a
 * startup-scan-synthesized analogue) when the event matches one of the
 * seven Trigger_Source rules.
 *
 * Carries the deduplication identity plus the precomputed fields the
 * Eyes_Reactor needs to build its endpoint URL.
 */
export interface TriggerMention {
  identity: MentionIdentity
  repoFullName: string
  sourceType: SourceType
  sourceId: string
  /** Owner/repo split, precomputed for downstream API calls. */
  owner: string
  repo: string
  /** For comment-shaped sources (issue_comment, pr_comment, pr_review_comment). */
  commentId?: number
  /** For issue/PR-shaped sources (issue_body, pr_body, issue_assignment, pr_review_request). */
  issueOrPrNumber?: number
}

// ── Webhook Payload Shapes ─────────────────────────────────────────
//
// These describe the subset of GitHub webhook payload fields that the
// Event_Filter and Eyes_Reactor read. Rockhub does not validate the
// full payload — it only reads what it needs and passes the entire
// untouched payload through to the spawned openclaw subagent.

interface RepositoryRef {
  full_name: string
  name: string
  owner: { login: string }
}

interface UserRef {
  login: string
  id: number
}

interface IssueRef {
  number: number
  title: string
  body: string | null
  user: UserRef
  /** Present when the "issue" is actually a pull request (issue_comment events). */
  pull_request?: { url: string }
}

interface PullRequestRef {
  number: number
  title: string
  body: string | null
  user: UserRef
  requested_reviewers?: UserRef[]
}

interface CommentRef {
  id: number
  body: string
  user: UserRef
}

/**
 * Payload shape for `issues.opened`, `issues.edited`, `issues.reopened`.
 * The Event_Filter scans `issue.body` for a Bot_Mention.
 */
export interface IssuePayload {
  action: 'opened' | 'edited' | 'reopened'
  repository: RepositoryRef
  issue: IssueRef
  sender: UserRef
}

/**
 * Payload shape for `issues.assigned`. The Event_Filter compares
 * `assignee.login` against `BOT_USERNAME` (case-insensitive).
 */
export interface IssueAssignedPayload {
  action: 'assigned'
  repository: RepositoryRef
  issue: IssueRef
  assignee: UserRef
  sender: UserRef
}

/**
 * Payload shape for `issue_comment.created`, `issue_comment.edited`.
 * GitHub delivers PR comments as `issue_comment` events with
 * `issue.pull_request` populated; the Event_Filter routes accordingly
 * to either `issue_comment` or `pr_comment` source types.
 */
export interface IssueCommentPayload {
  action: 'created' | 'edited'
  repository: RepositoryRef
  issue: IssueRef
  comment: CommentRef
  sender: UserRef
}

/**
 * Payload shape for `pull_request.opened`, `pull_request.edited`,
 * `pull_request.reopened`. The Event_Filter scans
 * `pull_request.body` for a Bot_Mention.
 */
export interface PRPayload {
  action: 'opened' | 'edited' | 'reopened'
  repository: RepositoryRef
  pull_request: PullRequestRef
  sender: UserRef
}

/**
 * Payload shape for `pull_request.review_requested`. The Event_Filter
 * compares `requested_reviewer.login` against `BOT_USERNAME`.
 */
export interface PRReviewRequestedPayload {
  action: 'review_requested'
  repository: RepositoryRef
  pull_request: PullRequestRef
  requested_reviewer: UserRef
  sender: UserRef
}

/**
 * Payload shape for `pull_request_review_comment.created`,
 * `pull_request_review_comment.edited`. The Event_Filter scans
 * `comment.body` for a Bot_Mention.
 */
export interface PRReviewCommentPayload {
  action: 'created' | 'edited'
  repository: RepositoryRef
  pull_request: PullRequestRef
  comment: CommentRef
  sender: UserRef
}

/**
 * The unmodified GitHub webhook payload object as delivered by GitHub.
 * Rockhub passes it through to the spawned openclaw subagent untouched.
 *
 * This union covers the six payload shapes that correspond to the
 * twelve `(name, action)` pairs Rockhub subscribes to.
 */
export type WebhookPayload =
  | IssuePayload
  | IssueAssignedPayload
  | IssueCommentPayload
  | PRPayload
  | PRReviewRequestedPayload
  | PRReviewCommentPayload

// ── Raw Webhook Event ──────────────────────────────────────────────

/**
 * The Event_Filter's input: a discriminated union over the twelve
 * `(name, action)` pairs Rockhub subscribes to (see Property 3 in the
 * design document). The `name` field uses the `event.action` form
 * `@octokit/webhooks` exposes (e.g. `'issues.opened'`).
 *
 * Subscribed events:
 *   1.  issues.opened
 *   2.  issues.edited
 *   3.  issues.reopened
 *   4.  issues.assigned
 *   5.  issue_comment.created
 *   6.  issue_comment.edited
 *   7.  pull_request.opened
 *   8.  pull_request.edited
 *   9.  pull_request.reopened
 *   10. pull_request.review_requested
 *   11. pull_request_review_comment.created
 *   12. pull_request_review_comment.edited
 */
export type RawWebhookEvent =
  | { name: 'issues.opened' | 'issues.edited' | 'issues.reopened'; payload: IssuePayload }
  | { name: 'issues.assigned'; payload: IssueAssignedPayload }
  | { name: 'issue_comment.created' | 'issue_comment.edited'; payload: IssueCommentPayload }
  | {
      name: 'pull_request.opened' | 'pull_request.edited' | 'pull_request.reopened'
      payload: PRPayload
    }
  | { name: 'pull_request.review_requested'; payload: PRReviewRequestedPayload }
  | {
      name: 'pull_request_review_comment.created' | 'pull_request_review_comment.edited'
      payload: PRReviewCommentPayload
    }

// ── Synthesized Payload ────────────────────────────────────────────

/**
 * A JSON object the Startup_Scanner constructs to mimic the shape of a
 * real GitHub webhook payload for a Trigger_Mention discovered during
 * the startup scan. Lets the spawned openclaw subagent accept a
 * uniform input format regardless of whether the mention came from a
 * webhook or a startup scan.
 *
 * The full builder lives in `./synthesized-payload`. This interface is
 * declared here because `OpenclawInvocation.payload` references it and
 * `lib/types` is the natural home for cross-cutting types.
 */
export interface SynthesizedPayload {
  /** Marker for the spawned subagent. */
  rockhub_origin: 'startup-scan'
  /** Synthesized event name, e.g. `'issue_comment.synthesized'`. */
  event_name: string
  repository: RepositoryRef
  issue?: { number: number; title: string; body: string | null; user: { login: string } }
  pull_request?: {
    number: number
    title: string
    body: string | null
    user: { login: string }
  }
  comment?: { id: number; body: string; user: { login: string } }
  /** For startup-synthesized pr_review_request mentions. */
  requested_reviewer?: { login: string; id: number }
  /** For startup-synthesized issue_assignment mentions. */
  assignee?: { login: string }
}

// ── Openclaw Invocation Envelope ───────────────────────────────────

/**
 * The JSON envelope serialized to the spawned openclaw subagent via
 * the configured `OPENCLAW_PAYLOAD_TRANSPORT` (stdin by default).
 *
 * The envelope is deliberately small: it carries the skill reference
 * (always `'rockhub'`), the mention identity for traceability, the
 * GitHub event name and delivery id, an origin marker distinguishing
 * webhook deliveries from startup-scan-synthesized mentions, and the
 * full payload itself.
 */
export interface OpenclawInvocation {
  /** Always `'rockhub'` — kept explicit so the subagent can verify. */
  skill: 'rockhub'
  /** The Mention_Identity, propagated for traceability. */
  mentionIdentity: MentionIdentity
  /**
   * GitHub event name, e.g. `'issue_comment.created'` for webhook
   * deliveries or `'issue_comment.synthesized'` for startup-scan ones.
   */
  eventName: string
  /** GitHub delivery id, or a synthesized id for startup-scan mentions. */
  deliveryId: string
  /** Origin marker distinguishing real webhook deliveries from startup-scan ones. */
  origin: 'webhook' | 'startup-scan'
  /** The full webhook payload OR the SynthesizedPayload. */
  payload: WebhookPayload | SynthesizedPayload
}
