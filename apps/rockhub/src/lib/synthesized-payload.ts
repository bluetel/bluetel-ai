// Synthesized payload builder.
//
// The Startup_Scanner runs once at process start and discovers
// Trigger_Mentions that arrived while Rockhub was offline. For each
// such mention it has to construct a payload that mimics the shape of
// a real GitHub webhook delivery, so that the spawned `openclaw`
// subagent (and the `rockhub` skill it loads) can treat webhook-
// originated and startup-scan-originated mentions uniformly.
//
// `buildSynthesizedPayload` is that constructor. It takes the
// already-derived `TriggerMention` (produced by running a synthesized
// `RawWebhookEvent` through the same `Event_Filter` the webhook path
// uses) and the GitHub API-derived source objects the scanner already
// fetched, and returns a `SynthesizedPayload` whose populated fields
// match the shape a corresponding webhook delivery would have had.
//
// See design.md → "Data Models" → "WebhookPayload and SynthesizedPayload"
// and Requirement 5.6.

import type { SourceType, SynthesizedPayload, TriggerMention } from './types'

// ── Public Inputs ──────────────────────────────────────────────────

/**
 * Subset of GitHub API-derived source objects the Startup_Scanner has
 * already fetched for a given Trigger_Mention. The builder picks the
 * fields it needs based on `mention.sourceType`; callers populate only
 * the fields relevant to that source type.
 *
 * The shapes mirror the corresponding sub-objects on the real webhook
 * payloads so the spawned subagent does not have to special-case
 * synthesized payloads beyond the top-level `rockhub_origin` marker.
 */
export interface SynthesizedPayloadInputs {
  /** Authoritative repository object. Always required. */
  repository: { full_name: string; name: string; owner: { login: string } }
  /**
   * Required for `issue_body`, `issue_assignment`, `issue_comment`,
   * and `pr_comment` (GitHub delivers PR comments as issue_comment
   * events with this same `issue` shape, with `pull_request` set).
   */
  issue?: { number: number; title: string; body: string | null; user: { login: string } }
  /** Required for `pr_body`, `pr_review_comment`, `pr_review_request`. */
  pull_request?: {
    number: number
    title: string
    body: string | null
    user: { login: string }
  }
  /** Required for `issue_comment`, `pr_comment`, `pr_review_comment`. */
  comment?: { id: number; body: string; user: { login: string } }
  /** Required for `pr_review_request`. */
  requested_reviewer?: { login: string; id: number }
  /** Required for `issue_assignment`. */
  assignee?: { login: string }
}

// ── Event Name Mapping ─────────────────────────────────────────────

/**
 * Maps a `SourceType` to the synthesized event name. Mirrors the real
 * GitHub event name that would have delivered the mention via webhook,
 * suffixed with `.synthesized` so the spawned subagent can distinguish
 * scan-originated payloads from real deliveries.
 *
 * Note `pr_comment` maps to `issue_comment.synthesized`: GitHub
 * delivers PR comments as `issue_comment` events with `issue.pull_request`
 * populated, and the synthesized payload mirrors that shape.
 */
const SOURCE_TYPE_TO_EVENT_NAME: Readonly<Record<SourceType, string>> = {
  issue_body: 'issues.synthesized',
  issue_assignment: 'issues.synthesized',
  issue_comment: 'issue_comment.synthesized',
  pr_body: 'pull_request.synthesized',
  pr_comment: 'issue_comment.synthesized',
  pr_review_comment: 'pull_request_review_comment.synthesized',
  pr_review_request: 'pull_request.synthesized',
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Build a `SynthesizedPayload` for a Trigger_Mention discovered by the
 * Startup_Scanner.
 *
 * The returned payload's populated fields match the shape that the
 * corresponding real webhook delivery would have had:
 *
 *   - `issue_body`        → `issue` populated
 *   - `issue_assignment`  → `issue` and `assignee` populated
 *   - `issue_comment`     → `issue` and `comment` populated
 *   - `pr_body`           → `pull_request` populated
 *   - `pr_comment`        → `issue` and `comment` populated (GitHub
 *                           delivers PR comments as issue_comment
 *                           events; mirroring that shape lets the
 *                           subagent dispatch on event_name alone)
 *   - `pr_review_comment` → `pull_request` and `comment` populated
 *   - `pr_review_request` → `pull_request` and `requested_reviewer`
 *                           populated
 *
 * `rockhub_origin` is always `'startup-scan'` and `event_name` is the
 * real GitHub event name for the mention's source type, suffixed with
 * `.synthesized`.
 *
 * @throws if a required input field for the given `sourceType` is
 *   missing — the Startup_Scanner is responsible for fetching the
 *   relevant source object before invoking the builder, so a missing
 *   field is a programmer error rather than a runtime data error.
 */
export const buildSynthesizedPayload = (
  mention: TriggerMention,
  inputs: SynthesizedPayloadInputs,
): SynthesizedPayload => {
  const base: SynthesizedPayload = {
    rockhub_origin: 'startup-scan',
    event_name: SOURCE_TYPE_TO_EVENT_NAME[mention.sourceType],
    repository: inputs.repository,
  }

  switch (mention.sourceType) {
    case 'issue_body':
      return {
        ...base,
        issue: requireField(inputs.issue, mention.sourceType, 'issue'),
      }

    case 'issue_assignment':
      return {
        ...base,
        issue: requireField(inputs.issue, mention.sourceType, 'issue'),
        assignee: requireField(inputs.assignee, mention.sourceType, 'assignee'),
      }

    case 'issue_comment':
      return {
        ...base,
        issue: requireField(inputs.issue, mention.sourceType, 'issue'),
        comment: requireField(inputs.comment, mention.sourceType, 'comment'),
      }

    case 'pr_body':
      return {
        ...base,
        pull_request: requireField(inputs.pull_request, mention.sourceType, 'pull_request'),
      }

    case 'pr_comment':
      // GitHub delivers PR comments as `issue_comment` events whose
      // `issue` payload describes the PR-as-issue. Mirror that shape
      // so the spawned subagent can dispatch on event_name alone.
      return {
        ...base,
        issue: requireField(inputs.issue, mention.sourceType, 'issue'),
        comment: requireField(inputs.comment, mention.sourceType, 'comment'),
      }

    case 'pr_review_comment':
      return {
        ...base,
        pull_request: requireField(inputs.pull_request, mention.sourceType, 'pull_request'),
        comment: requireField(inputs.comment, mention.sourceType, 'comment'),
      }

    case 'pr_review_request':
      return {
        ...base,
        pull_request: requireField(inputs.pull_request, mention.sourceType, 'pull_request'),
        requested_reviewer: requireField(
          inputs.requested_reviewer,
          mention.sourceType,
          'requested_reviewer',
        ),
      }
  }
}

// ── Internal Helpers ───────────────────────────────────────────────

/**
 * Narrow an optional input field to a required one, throwing a clear
 * error when it is missing. The caller (Startup_Scanner) is expected
 * to have fetched the relevant source object before invoking the
 * builder, so a missing field reflects a programmer error rather than
 * a recoverable runtime condition.
 */
const requireField = <T>(value: T | undefined, sourceType: SourceType, fieldName: string): T => {
  if (value === undefined) {
    throw new Error(
      `buildSynthesizedPayload: missing required input '${fieldName}' for sourceType '${sourceType}'`,
    )
  }
  return value
}
