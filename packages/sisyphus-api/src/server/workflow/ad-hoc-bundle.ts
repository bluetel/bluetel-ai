import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { setupBundles, setupBundleVersions } from '../../db'

/**
 * What an ad hoc run bootstraps from (FR-016, FR-086, FR-129).
 *
 * A profile launch never asks this question: the profile version pins a bundle version that was
 * checked when the profile was enabled (FR-124), so by the time anybody launches, the pairing has
 * already been validated. An ad hoc launch has no profile, which means the bundle version arrives
 * straight off a form and the "only enabled setup bundles are selectable" half of FR-016 has
 * nowhere else to be enforced.
 *
 * A setup bundle is arbitrary shell run with the instance's privileges
 * (contracts/setup-bundle.md), so this is not a tidiness check. Disabling a bundle is how an admin
 * takes a broken or untrusted archive out of service, and a launch path that could still name its
 * version would make that action advisory.
 */

/** Anything that can run this module's statements — the pooled handle or a transaction on it. */
export type BundleReader = Pick<SisyphusDatabase, 'select'>

/**
 * The first row, honestly typed. `noUncheckedIndexedAccess` is off in this project, so `rows[0]`
 * is typed as present even when the result set is empty.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** The bundle version named does not exist. */
export const bundleVersionNotAvailableError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No such setup bundle version.' })

/**
 * The bundle exists but may not be used to start a run.
 *
 * `CONFLICT` and plainly worded: only an admin reaches here, and an admin may see every bundle in
 * the platform, so naming the state discloses nothing and telling them to enable it is more use
 * than telling them to check the id.
 */
export const bundleNotSelectableError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/**
 * Check that a named setup bundle version may start a run (FR-016, FR-086).
 *
 * @param reader - The transaction the launch runs in, so the check and the insert see one snapshot.
 * @param setupBundleVersionId - The version the form submitted.
 * @returns The same id, so the caller can use this in place of the raw input.
 */
export const requireSelectableBundleVersion = async (
  reader: BundleReader,
  setupBundleVersionId: string,
): Promise<string> => {
  const row = firstRow(
    await reader
      .select({
        id: setupBundleVersions.id,
        enabled: setupBundles.enabled,
        archivedAt: setupBundles.archivedAt,
      })
      .from(setupBundleVersions)
      .innerJoin(setupBundles, eq(setupBundles.id, setupBundleVersions.setupBundleId))
      .where(eq(setupBundleVersions.id, setupBundleVersionId))
      .limit(1),
  )

  if (row === undefined) {
    throw bundleVersionNotAvailableError()
  }

  if (row.archivedAt !== null) {
    throw bundleNotSelectableError('That setup bundle has been archived.')
  }

  if (!row.enabled) {
    throw bundleNotSelectableError('That setup bundle is disabled and cannot start runs.')
  }

  return row.id
}
