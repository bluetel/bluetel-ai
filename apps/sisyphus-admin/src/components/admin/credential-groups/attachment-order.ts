import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Preference order, made legible and made editable (T027, FR-062, FR-064).
 *
 * ## The order is a rule, so the screen states the rule
 *
 * FR-064: selection takes the **first** attached group, in preference order, that has an available
 * credential, and picks least-recently-used within it. An editor that rendered the attachments as a
 * list with arrows beside them would be showing an order whose meaning the administrator has to
 * already know — and the two readings, "tried first" and "most important", are not the same
 * decision. So every row carries {@link preferenceReadout}, which says its place *and* what that
 * place does, and the panel above it states the selection rule in one sentence.
 *
 * ## Why a move produces the whole order
 *
 * `credentialGroups.reorder` takes the complete list and refuses one that disagrees with what is
 * attached, because a delta would be applied to whatever the database holds now rather than to the
 * order the panel was looking at when the administrator pressed the arrow. {@link moveAttachment}
 * therefore returns the full sequence of ids, built from the rows the panel last read — which is
 * exactly the list the router will check against, so a concurrent attach turns into a refusal and a
 * reload rather than into a silent reshuffle.
 */

/** One attachment, as `forProfile` returns it. Inferred from the router, never mirrored. */
export type ProfileAttachment =
  RouterOutputs['admin']['credentialGroups']['forProfile']['attachments'][number]

/** Which way a row moves. Named for what it does to the *order*, not for which way the arrow points. */
export type AttachmentMove = 'earlier' | 'later'

/** `1st`, `2nd`, `3rd`, `4th`. English ordinals, including the teens the naive rule gets wrong. */
export const ordinal = (value: number): string => {
  const lastTwo = value % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${String(value)}th`

  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] ?? 'th'
  return `${String(value)}${suffix}`
}

/**
 * What a row's position means, in the words FR-064 defines it with.
 *
 * "1st of 3" alone is a number; "tried first" is the behaviour. Both are given because the number is
 * what the administrator is dragging and the behaviour is what they are deciding.
 *
 * @param position - The attachment's 1-based position, as the router reports it.
 * @param total - How many groups are attached, so the last row can say it is the last.
 */
export const preferenceReadout = (position: number, total: number): string => {
  const place = `${ordinal(position)} of ${String(total)}`

  if (position === 1) return `${place} — tried first`
  if (position === total) return `${place} — tried last`
  return `${place} — tried after the ${ordinal(position - 1)}`
}

/** The attached group ids, in the order the panel last read them. */
export const attachmentOrderIds = (attachments: readonly ProfileAttachment[]): readonly string[] =>
  attachments.map((attachment) => attachment.credentialGroupId)

/**
 * The order this list would have after one row moved one place.
 *
 * @param attachments - The rows as last read, in preference order.
 * @param credentialGroupId - The row being moved.
 * @param move - `earlier` to have it tried sooner, `later` to have it tried after the next one.
 * @returns The complete new order of group ids, or `undefined` when the move is not available —
 *   the row is already at the end it is being moved towards, or it is not in this list at all.
 *   `undefined` rather than the unchanged order so the panel cannot send a reorder that reorders
 *   nothing, which would put a non-event on the audit trail (FR-067).
 */
export const moveAttachment = (
  attachments: readonly ProfileAttachment[],
  credentialGroupId: string,
  move: AttachmentMove,
): readonly string[] | undefined => {
  const order = attachmentOrderIds(attachments)
  const from = order.indexOf(credentialGroupId)
  const to = move === 'earlier' ? from - 1 : from + 1

  if (from === -1 || to < 0 || to >= order.length) return undefined

  const moved = [...order]
  moved.splice(to, 0, ...moved.splice(from, 1))

  return moved
}

/** Whether a row can move that way at all, so the control is disabled rather than failing on press. */
export const canMoveAttachment = (
  attachments: readonly ProfileAttachment[],
  credentialGroupId: string,
  move: AttachmentMove,
): boolean => moveAttachment(attachments, credentialGroupId, move) !== undefined
