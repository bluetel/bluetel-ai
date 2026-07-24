// Mention_Identity composition, parsing, bot-mention matching, and
// filesystem-safe sanitization helpers.
//
// A Mention_Identity is the deduplication key the Mention_Queue's
// Processed_Set uses to guarantee at-most-once handoff per source
// object. Its canonical form is `${repoFullName}:${sourceType}:${sourceId}`.
//
// The `sourceId` shape varies per `sourceType` (see
// MentionIdentityComponents). For most source types the `sourceId` is a
// single segment, so the full identity has three colon-separated parts.
// For `pr_review_request` the `sourceId` is itself colon-separated
// (`{pr_number}:{reviewer_user_id}`), so the full identity has four
// colon-separated parts. `repoFullName` may contain a `/` (e.g.
// `owner/repo`) but never contains a `:`, so splitting on `:` is safe.

import type { MentionIdentity, MentionIdentityComponents, SourceType } from './types'

// ── Source-type discriminator ──────────────────────────────────────

/**
 * The source types whose `sourceId` is itself colon-separated. Today
 * only `pr_review_request` has this shape (`{pr_number}:{reviewer_user_id}`).
 * Kept as a Set so adding new compound source types in the future is a
 * one-line change.
 */
const COMPOUND_SOURCE_ID_TYPES: ReadonlySet<SourceType> = new Set<SourceType>(['pr_review_request'])

const ALL_SOURCE_TYPES: ReadonlySet<SourceType> = new Set<SourceType>([
  'issue_body',
  'issue_assignment',
  'issue_comment',
  'pr_body',
  'pr_comment',
  'pr_review_comment',
  'pr_review_request',
])

const isSourceType = (value: string): value is SourceType =>
  ALL_SOURCE_TYPES.has(value as SourceType)

// ── composeIdentity ────────────────────────────────────────────────

/**
 * Joins the structured components of a Mention_Identity into the
 * canonical `${repoFullName}:${sourceType}:${sourceId}` form.
 *
 * Note: this function does not validate that `repoFullName` is free of
 * colons or that `sourceId` matches the shape expected for the given
 * `sourceType`. The caller (Event_Filter / Startup_Scanner) is
 * responsible for producing well-formed components. `parseIdentity` is
 * the round-trip inverse so long as that contract is honoured.
 */
export const composeIdentity = (components: MentionIdentityComponents): MentionIdentity =>
  `${components.repoFullName}:${components.sourceType}:${components.sourceId}`

// ── parseIdentity ──────────────────────────────────────────────────

/**
 * Parses a Mention_Identity string back into its structured components.
 * Inverse of `composeIdentity`.
 *
 * Splitting strategy: split the identity on `:`, validate the second
 * segment is a known `SourceType`, then rejoin the trailing segment(s)
 * to reconstruct `sourceId` according to the source type's shape.
 *
 * - Three segments → `sourceId` is the third segment.
 * - Four segments AND sourceType is a compound-id type
 *   (`pr_review_request`) → `sourceId` is the third and fourth
 *   segments rejoined with `:`.
 *
 * Any other shape is malformed; an Error is thrown so callers cannot
 * silently misinterpret a corrupted identity.
 */
export const parseIdentity = (identity: MentionIdentity): MentionIdentityComponents => {
  const segments = identity.split(':')

  if (segments.length < 3) {
    throw new Error(
      `Invalid Mention_Identity "${identity}": expected at least 3 colon-separated segments, got ${String(segments.length)}.`,
    )
  }

  const repoFullName = segments[0]
  const sourceTypeRaw = segments[1]

  if (!isSourceType(sourceTypeRaw)) {
    throw new Error(
      `Invalid Mention_Identity "${identity}": unknown sourceType "${sourceTypeRaw}".`,
    )
  }

  const sourceType: SourceType = sourceTypeRaw
  const isCompound = COMPOUND_SOURCE_ID_TYPES.has(sourceType)
  const expectedSegments = isCompound ? 4 : 3

  if (segments.length !== expectedSegments) {
    throw new Error(
      `Invalid Mention_Identity "${identity}": sourceType "${sourceType}" expects ${String(expectedSegments)} segments, got ${String(segments.length)}.`,
    )
  }

  const sourceId = segments.slice(2).join(':')

  return { repoFullName, sourceType, sourceId }
}

// ── matchesBotMention ──────────────────────────────────────────────

/**
 * Case-insensitive substring match for a Bot_Mention (`@{botUsername}`)
 * inside a body of text.
 *
 * Per Requirement 9.2 / Property 17: returns `true` iff the lowercased
 * `text` contains the lowercased substring `"@" + botUsername`. No
 * word-boundary or punctuation enforcement — GitHub's own mention
 * detection is forgiving, and downstream filters already deduplicate
 * by Mention_Identity, so a slightly permissive match is preferred to
 * a fragile one.
 */
export const matchesBotMention = (text: string, botUsername: string): boolean => {
  const needle = `@${botUsername.toLowerCase()}`
  return text.toLowerCase().includes(needle)
}

// ── sanitizeForFilename ────────────────────────────────────────────

/**
 * Filesystem-safe sanitization of a Mention_Identity for inclusion in
 * the per-invocation openclaw log filename (Property 15).
 *
 * Replaces every character outside `[A-Za-z0-9._-]` with `_`. This
 * strips `/`, `:`, whitespace (spaces, tabs, newlines, etc.), and
 * control characters while preserving the segment boundaries enough
 * for an operator to recognize the identity in a directory listing.
 *
 * Replacement is per-character (rather than collapsing runs of
 * invalid characters) so that two distinct identities cannot collide
 * after sanitization.
 */
export const sanitizeForFilename = (identity: MentionIdentity): string =>
  identity.replace(/[^A-Za-z0-9._-]/g, '_')
