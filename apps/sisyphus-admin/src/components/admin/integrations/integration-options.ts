import type { RouterOutputs } from '@bluetel-ai/sisyphus-api/client'

import type { OwnerOption, ProfileOption } from './integration-editor'

/**
 * What the editor's two pickers are offered (T199, FR-130, FR-133).
 *
 * Both lists are filtered rather than shown whole, and each filter is a requirement:
 *
 * - **Mappings may only name a profile a run could actually start from.** FR-130 has the first
 *   matching mapping win outright, so a mapping pointing at an archived profile, a disabled one, or
 *   one with no published version is a ticket that resolves and then fails — worse than a ticket
 *   that resolves to nothing, because FR-130's skip-with-a-reason never happens. The three are
 *   excluded here so the editor cannot offer them.
 * - **A default owner must be someone who can still be held accountable.** FR-133 exists so a run
 *   started unattended has an owner; a deactivated user is not one, and FR-176 already flags the
 *   runs they left behind. Only active users are offered.
 *
 * Pure, and separate from the screen, because the screen cannot be driven by a test in this app —
 * these two functions are where the decisions live so they can be.
 */

type ProfileListingOutput = RouterOutputs['admin']['profiles']['list']['items'][number]
type UserListingOutput = RouterOutputs['admin']['users']['list']['items'][number]

/**
 * A profile a mapping may resolve to.
 *
 * The label carries the pinned version, because an admin choosing between two profiles with
 * similar names is choosing between two configurations, and the version is what distinguishes
 * them.
 */
export const toProfileOptions = (
  profiles: readonly ProfileListingOutput[],
): readonly ProfileOption[] =>
  profiles
    .filter(
      (profile) =>
        profile.archivedAt === null && profile.enabled && profile.currentVersion !== undefined,
    )
    .map((profile) => ({
      value: profile.id,
      label: `${profile.name} — v${String(profile.currentVersion?.version ?? 0)}`,
    }))

/**
 * Someone who could own what this board starts.
 *
 * Labelled by display name, falling back to the email when the identity provider supplied a blank
 * one. `display_name` is `not null` but not non-empty, and the email is the identity the platform
 * actually authenticated — so it is the honest fallback rather than a blank row an admin would have
 * to pick between two of.
 */
export const toOwnerOptions = (users: readonly UserListingOutput[]): readonly OwnerOption[] =>
  users
    .filter((user) => user.isActive)
    .map((user) => ({
      value: user.id,
      label: user.displayName.trim() === '' ? user.email : user.displayName,
    }))
