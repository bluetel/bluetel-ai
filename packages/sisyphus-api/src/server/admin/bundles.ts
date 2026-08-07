import { TRPCError } from '@trpc/server'

import type { SetupBundle, SetupBundleVersion, ValidationRun } from '../../db'
import {
  bundleIdInput,
  bundleReferencesInput,
  listBundlesInput,
  registerBundleInput,
  replaceBundleArchiveInput,
  setBundleEnabledInput,
  updateBundleMetadataInput,
  validateBundleInput,
} from '../../schemas'
import { adminProcedure, authedProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import type { BundleListing, BundleReferences, ValidationRunListing } from './bundle-store'
import {
  findBundle,
  findBundleByName,
  findBundleVersion,
  insertBundle,
  insertBundleVersion,
  insertValidationRun,
  listBundles,
  listValidationRuns,
  lockBundleForVersioning,
  readBundleReferences,
  updateBundle,
} from './bundle-store'
import type { Page } from './user-queries'

/**
 * `admin.bundles` — registering, versioning and enabling setup bundles (FR-084..FR-086,
 * FR-090..FR-092, FR-147, FR-148, FR-167, FR-168).
 *
 * ## The one deliberate exception to admin-only
 *
 * Every mutation here is an `adminProcedure`, because a setup bundle is arbitrary shell run with
 * the instance's privileges and the whole trust boundary rests on bundles being
 * administrator-authored (contracts/setup-bundle.md). `bundles.list` is the exception: it is an
 * `authedProcedure`, because selecting a bundle is part of building an execution profile and any
 * authenticated user must be able to see the **enabled** list (FR-086).
 *
 * That exception is written as an explicit branch on `ctx.user.role`, not as an omitted check. A
 * non-admin's request is narrowed to enabled, unarchived bundles **after** input validation, so a
 * caller passing `enabledOnly: false` is answered with the enabled list rather than refused —
 * refusing would tell them the wider list exists, and quietly honouring the flag would leak it.
 *
 * ## Why registration and replacement look almost the same and are not
 *
 * `register` creates the parent row and version 1. `replaceArchive` creates a version and touches
 * nothing else. Neither ever updates a version row: archives are immutable once registered, so a
 * replacement leaves the previous archive byte-for-byte intact and an in-flight workflow that
 * pinned it is unaffected (FR-090, FR-092). The storage layer enforces the same rule from the other
 * side — the panel's upload derives an object key no second upload can collide with — so an
 * "overwrite the existing archive" implementation would have to defeat both.
 *
 * Every one of these acts is written to `configuration_audit` with the acting admin, inside the
 * same transaction as the change itself (FR-178).
 */

/**
 * The one refusal for a bundle or version this router cannot act on.
 *
 * `NOT_FOUND` rather than `FORBIDDEN`, and singular for both a missing bundle and a missing
 * version, for the same reason `grantTargetNotFoundError` is: a refusal that distinguished the two
 * would answer "does this id exist?" for ids the caller has not been shown (FR-190).
 */
export const bundleNotFoundError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No such setup bundle or bundle version.' })

/** Refusal for a name already taken. The name is the caller's own input, so echoing it leaks nothing. */
export const duplicateBundleNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `A setup bundle named ${name} already exists. Replace its archive to publish a new version.`,
  })

/** What `register` and `replaceArchive` both answer with. */
export interface BundleRegistration {
  readonly bundle: SetupBundle
  /** The version this call created. Never an existing one — these procedures only ever insert. */
  readonly version: SetupBundleVersion
}

/**
 * How many validation runs one bundle's history returns.
 *
 * Fixed rather than paginated because `admin.bundles` has no `listValidationRunsInput` schema, and
 * inventing one here would put a second source of truth for a procedure's input next to
 * `src/schemas/bundle.ts`. A bounded read is the honest thing to do until that schema exists.
 */
const VALIDATION_RUN_HISTORY_LIMIT = 50

/** Detail recorded on the audit trail for an archive change. Carries no credential and no contents. */
const archiveAuditDetail = (version: SetupBundleVersion): Record<string, unknown> => ({
  version: version.version,
  contentDigest: version.contentDigest,
  s3Key: version.s3Key,
  sizeBytes: version.sizeBytes,
})

export const bundlesRouter = createTRPCRouter({
  /**
   * The bundle list (FR-086, FR-148).
   *
   * **The one procedure on this router a non-admin may call.** An admin sees everything the input
   * asks for, including disabled and archived bundles; anyone else sees the enabled, unarchived
   * list and nothing else.
   */
  list: authedProcedure
    .input(listBundlesInput)
    .query(async ({ ctx, input }): Promise<Page<BundleListing>> => {
      const isAdmin = ctx.user.role === 'admin'

      return listBundles(ctx.db, {
        // A non-admin's filters are not honoured and not refused: they are narrowed. Selecting a
        // bundle for a profile only ever needs the enabled set (FR-086).
        enabledOnly: isAdmin ? input.enabledOnly : true,
        includeArchived: isAdmin ? input.includeArchived : false,
        limit: input.limit,
        cursor: input.cursor,
      })
    }),

  /**
   * Register a new bundle and its first archive (FR-085, FR-167).
   *
   * The archive is already in encrypted private storage by the time this is called — the panel
   * uploads it, captures the sha256 of the bytes it stored, and passes the key and digest here. The
   * digest is what the executor re-verifies after download, so it is recorded rather than
   * recomputed (FR-087).
   *
   * The bundle is created **disabled**. Enabling is a separate, separately audited act, which is
   * what keeps an unvalidated bundle from becoming selectable the moment it is uploaded.
   */
  register: adminProcedure.input(registerBundleInput).mutation(
    async ({ ctx, input }): Promise<BundleRegistration> =>
      ctx.db.transaction(async (tx) => {
        if ((await findBundleByName(tx, input.name)) !== undefined) {
          throw duplicateBundleNameError(input.name)
        }

        const bundle = await insertBundle(tx, {
          name: input.name,
          description: input.description,
          spendCapsEnforceable: input.spendCapsEnforceable,
          createdByUserId: ctx.user.id,
        })

        const version = await insertBundleVersion(tx, {
          setupBundleId: bundle.id,
          version: 1,
          s3Key: input.s3Key,
          contentDigest: input.contentDigest,
          sizeBytes: input.sizeBytes,
          registeredByUserId: ctx.user.id,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'setup_bundle',
          entityId: bundle.id,
          entityVersion: version.version,
          action: 'registered',
          detail: archiveAuditDetail(version),
        })

        return { bundle, version }
      }),
  ),

  /**
   * Publish a new archive for an existing bundle (FR-090).
   *
   * This is an insert, never an update. The bundle row is locked first so two concurrent
   * replacements queue rather than both computing the same next version number; see
   * `lockBundleForVersioning`.
   *
   * Recorded as `replaced` rather than `updated`, because the two are different events: one
   * created an immutable version and the other edited a row in place.
   */
  replaceArchive: adminProcedure.input(replaceBundleArchiveInput).mutation(
    async ({ ctx, input }): Promise<BundleRegistration> =>
      ctx.db.transaction(async (tx) => {
        const locked = await lockBundleForVersioning(tx, input.setupBundleId)
        if (locked === undefined) {
          throw bundleNotFoundError()
        }

        const version = await insertBundleVersion(tx, {
          setupBundleId: locked.bundle.id,
          version: locked.highestVersion + 1,
          s3Key: input.s3Key,
          contentDigest: input.contentDigest,
          sizeBytes: input.sizeBytes,
          registeredByUserId: ctx.user.id,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'setup_bundle',
          entityId: locked.bundle.id,
          entityVersion: version.version,
          action: 'replaced',
          detail: {
            ...archiveAuditDetail(version),
            previousVersion: locked.highestVersion,
          },
        })

        return { bundle: locked.bundle, version }
      }),
  ),

  /**
   * Edit name, description or the spend-cap declaration (FR-086, FR-093).
   *
   * Deliberately cannot reach the archive. `updateBundleMetadataInput` has no key, digest or size
   * field, so "update the bundle" is not a path by which an archive can be mutated.
   */
  updateMetadata: adminProcedure.input(updateBundleMetadataInput).mutation(
    async ({ ctx, input }): Promise<SetupBundle> =>
      ctx.db.transaction(async (tx) => {
        const existing = await findBundle(tx, input.setupBundleId)
        if (existing === undefined) {
          throw bundleNotFoundError()
        }

        if (input.name !== undefined && input.name !== existing.name) {
          const clash = await findBundleByName(tx, input.name)
          if (clash !== undefined) {
            throw duplicateBundleNameError(input.name)
          }
        }

        const updated = await updateBundle(tx, input.setupBundleId, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description ?? null }),
          ...(input.spendCapsEnforceable === undefined
            ? {}
            : { spendCapsEnforceable: input.spendCapsEnforceable }),
        })

        if (updated === undefined) {
          throw bundleNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'setup_bundle',
          entityId: updated.id,
          action: 'updated',
          detail: {
            name: updated.name,
            spendCapsEnforceable: updated.spendCapsEnforceable,
          },
        })

        return updated
      }),
  ),

  /**
   * Enable or disable a bundle (FR-092, FR-168).
   *
   * Disabling is the operation FR-092 offers **instead of** deletion, and it deliberately does not
   * consult `references`: a bundle referenced by an in-flight workflow is exactly the bundle an
   * admin most needs to be able to take out of circulation, and disabling does not affect runs
   * already under way. Refusing here would leave them with nothing to do.
   */
  setEnabled: adminProcedure.input(setBundleEnabledInput).mutation(
    async ({ ctx, input }): Promise<SetupBundle> =>
      ctx.db.transaction(async (tx) => {
        const existing = await findBundle(tx, input.setupBundleId)
        if (existing === undefined) {
          throw bundleNotFoundError()
        }

        // A no-op still returns the row, but writes no audit entry: nothing changed, so there is
        // nothing to record, and a trail padded with non-events is harder to read.
        if (existing.enabled === input.enabled) {
          return existing
        }

        const updated = await updateBundle(tx, input.setupBundleId, { enabled: input.enabled })
        if (updated === undefined) {
          throw bundleNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'setup_bundle',
          entityId: updated.id,
          action: input.enabled ? 'enabled' : 'disabled',
        })

        return updated
      }),
  ),

  /** What would break if this bundle went away, and whether it may be archived at all (FR-092). */
  references: adminProcedure
    .input(bundleReferencesInput)
    .query(async ({ ctx, input }): Promise<BundleReferences> => {
      if ((await findBundle(ctx.db, input.setupBundleId)) === undefined) {
        throw bundleNotFoundError()
      }
      return readBundleReferences(ctx.db, input.setupBundleId)
    }),

  /**
   * Ask for a validation run against one bundle version (FR-147).
   *
   * This opens the run and returns it; the control-plane job provisions the instance, walks the
   * bootstrap phases and completes the row. So the value returned here has `outcome: null` and
   * `endedAt: null`, and the panel says the run is in flight rather than claiming a verdict it does
   * not have.
   */
  validate: adminProcedure
    .input(validateBundleInput)
    .mutation(async ({ ctx, input }): Promise<ValidationRun> => {
      if ((await findBundleVersion(ctx.db, input.setupBundleVersionId)) === undefined) {
        throw bundleNotFoundError()
      }

      return insertValidationRun(ctx.db, {
        setupBundleVersionId: input.setupBundleVersionId,
        triggeredByUserId: ctx.user.id,
      })
    }),

  /**
   * Every validation recorded against any version of one bundle, newest first (FR-148).
   *
   * A pass against an older version stays visible next to a failure against the current one,
   * because "it validated once" and "it validates now" are different claims and the panel must not
   * conflate them (contracts/setup-bundle.md).
   */
  validationRuns: adminProcedure
    .input(bundleIdInput)
    .query(async ({ ctx, input }): Promise<readonly ValidationRunListing[]> => {
      if ((await findBundle(ctx.db, input.setupBundleId)) === undefined) {
        throw bundleNotFoundError()
      }
      return listValidationRuns(ctx.db, input.setupBundleId, VALIDATION_RUN_HISTORY_LIMIT)
    }),
})

export type BundlesRouter = typeof bundlesRouter
