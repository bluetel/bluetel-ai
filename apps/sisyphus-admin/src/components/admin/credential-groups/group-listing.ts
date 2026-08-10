import { formatTimestamp } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

import type { DeletionCondition } from './deletion-refusal'

/**
 * How one credential group reads on the management screen (T026, FR-060, FR-066).
 *
 * ## The FR-066 conditions are shown before the attempt, in the same words as after it
 *
 * `credentialGroups.list` returns the two counts precisely so an administrator can see that a group
 * holds four credentials and that two profiles draw on it **without pressing Delete and reading a
 * refusal**. {@link deletionBlockersFromCounts} turns those counts into the same closed vocabulary
 * `deletion-refusal.ts` classifies the router's message into, so the condition read ahead of the
 * attempt and the condition read after a refusal are the same named thing. Two vocabularies for one
 * rule would make the second reading look like a new problem.
 *
 * ## The counts can be right and still let a delete be refused
 *
 * `CredentialGroupListing.credentialCount` excludes archived credentials — an archived credential
 * is not capacity — whereas the router's reference sweep counts them, because
 * `agent_credentials.credential_group_id` is a foreign key an archived row still holds. So a group
 * whose only members are archived reads as deletable here and is refused by the router. That is not
 * a defect to paper over on either side: this screen answers "is this group worth keeping", the
 * sweep answers "would the delete succeed", and the refusal path exists for exactly the cases where
 * they differ. It is also why the card renders the router's refusal rather than trusting its own
 * arithmetic.
 */

/** One group, as the list procedure returns it. Inferred from the router, never mirrored. */
export type CredentialGroupListItem =
  RouterOutputs['admin']['credentialGroups']['list']['items'][number]

/**
 * Which FR-066 conditions the counts say apply right now.
 *
 * `unclassified` is never produced here — it exists in {@link DeletionCondition} for a *message*
 * line the panel does not recognise, and a count cannot be unrecognised.
 */
export const deletionBlockersFromCounts = (
  group: Pick<CredentialGroupListItem, 'credentialCount' | 'attachedProfileCount'>,
): readonly DeletionCondition[] => {
  const blockers: DeletionCondition[] = []

  if (group.credentialCount > 0) blockers.push('credential_member')
  if (group.attachedProfileCount > 0) blockers.push('profile_attachment')

  return blockers
}

/**
 * The sentence a blocker reads as before a delete has been attempted.
 *
 * Deliberately close to the router's own phrasing, and deliberately naming where the fix is, so an
 * administrator who reads this and then presses Delete anyway is told the same thing twice rather
 * than something new.
 */
export const describeDeletionBlocker = (
  blocker: DeletionCondition,
  group: Pick<CredentialGroupListItem, 'credentialCount' | 'attachedProfileCount'>,
): string => {
  if (blocker === 'credential_member') {
    return group.credentialCount === 1
      ? 'it holds 1 agent credential; move it to another group or archive it first'
      : `it holds ${String(group.credentialCount)} agent credentials; move them to another group or archive them first`
  }

  if (blocker === 'profile_attachment') {
    return group.attachedProfileCount === 1
      ? 'it is attached to 1 execution profile; detach it there first'
      : `it is attached to ${String(group.attachedProfileCount)} execution profiles; detach it there first`
  }

  return 'something still refers to it'
}

/** One group's readouts, all strings, so the card holds no formatting of its own. */
export interface CredentialGroupReadouts {
  readonly id: string
  readonly name: string
  readonly description: string
  /** `enabled`, `disabled` or `deleted`. The chip's whole text. */
  readonly state: string
  readonly credentials: string
  readonly attachedProfiles: string
  readonly created: string
  readonly enabled: boolean
  /** Archived groups are listed, and nothing may be done to them. */
  readonly archived: boolean
  /** What the counts say blocks a delete. Empty when the counts say nothing does. */
  readonly blockers: readonly DeletionCondition[]
  /** The blockers as sentences, in the order they are reported. */
  readonly blockerDetails: readonly string[]
}

/** What an absent description reads as. A dash, not an empty cell, so the row stays legible. */
export const ABSENT = '—'

/** Shape one group for the card. */
export const toCredentialGroupReadouts = (
  group: CredentialGroupListItem,
): CredentialGroupReadouts => {
  const archived = group.archivedAt !== null
  const blockers = deletionBlockersFromCounts(group)

  return {
    id: group.id,
    name: group.name,
    description: group.description ?? ABSENT,
    state: archived ? 'deleted' : group.enabled ? 'enabled' : 'disabled',
    credentials: String(group.credentialCount),
    attachedProfiles: String(group.attachedProfileCount),
    created: formatTimestamp(group.createdAt),
    enabled: group.enabled,
    archived,
    blockers,
    blockerDetails: blockers.map((blocker) => describeDeletionBlocker(blocker, group)),
  }
}
