import { TRPCError } from '@trpc/server'

import type { ExecutionProfile, ExecutionProfileVersion } from '../../db'
import {
  cloneProfileInput,
  createProfileInput,
  listProfilesInput,
  profileIdInput,
  setProfileEnabledInput,
  updateProfileInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import type { CredentialStoreWriter } from './credential-store'
import { readProfileCredentialGroups } from './credential-store'
import type { ProfileEnableCheck } from './profile-gate'
import {
  checkProfileCanBeEnabled,
  credentialGroupAttachmentCheck,
  mergeProfileEnableChecks,
  noPublishedVersionCheck,
  profileCannotBeEnabledError,
  unreadableSubjectCheck,
} from './profile-gate'
import type { ProfileListing, ProfileReferences, ProfileStoreWriter } from './profile-store'
import {
  findProfile,
  findProfileByName,
  findProfileVersion,
  insertProfile,
  insertProfileVersion,
  listProfiles,
  lockProfileForVersioning,
  readProfileEnableSubject,
  readProfileReferences,
  updateProfile,
} from './profile-store'
import type { Page } from './user-queries'

/**
 * `admin.profiles` — execution profiles, the launch preset and the unit of access control
 * (FR-121..FR-128).
 *
 * ## `setEnabled(true)` is the gate, and the gate is the point
 *
 * Everything else here is bookkeeping around one rule: a profile may not be enabled until FR-124's
 * validation passes. The bundle it pins must be enabled and unarchived, the workspace unarchived,
 * and the workspace version must hold at least one repository. That check is what stops a setup
 * bundle taken out of circulation staying attached to a profile and being discovered by an agent
 * halfway through a run.
 *
 * The check itself lives in `profile-gate.ts` and is a pure function of what the store already
 * read, so it makes no call of its own. The refusal **names the failing element** — see that
 * module for why "profile cannot be enabled" is not an acceptable message, and for which check
 * FR-124 no longer makes and why.
 *
 * `setEnabled(false)` is never gated. Disabling is what FR-128 offers instead of deletion, and a
 * profile whose repositories have gone is precisely the one an admin most needs to be able to take
 * out of circulation.
 *
 * The gate has a **second half** as of 003/FR-065: a profile with no attached credential group has
 * no agent identity it is permitted to work as, and is refused here — at configuration time — with
 * the missing attachment named. Failing at launch instead is the outcome that requirement exists to
 * prevent, because by then the run has been accepted and the queue would report a configuration
 * fault as capacity exhaustion. See `credentialGroupAttachmentCheck` in `profile-gate.ts`, and
 * `credential-groups.ts` for the other end of the same invariant: detaching a profile's last group
 * while it is enabled is refused rather than quietly making it unlaunchable.
 *
 * ## Editing publishes a version
 *
 * `update` inserts an `execution_profile_versions` row and moves `current_version_id`. It issues no
 * update against a version, and it cannot: the store exports no function that would let it. A
 * workflow records `execution_profile_version_id` at launch, and that row is what reconstructs its
 * exact configuration for the retention period (FR-065, FR-125, FR-126). Editing a version in place
 * would make the reconstruction a description of a later edit.
 *
 * A version pins the bundle **version** and workspace **version**, never their parent ids, so a
 * profile that passed the gate against one archive has not been silently re-pointed at another.
 *
 * Every act is written to `configuration_audit` with the acting admin, inside the same transaction
 * as the change itself (FR-178).
 */

/**
 * The one refusal for a profile, bundle version or workspace version this router cannot act on.
 *
 * `NOT_FOUND` rather than `FORBIDDEN`, and singular across the three, for the same reason
 * `grantTargetNotFoundError` is: a refusal that distinguished them would answer "does this id
 * exist?" for ids the caller has not been shown (FR-190).
 */
export const profileTargetNotFoundError = (): TRPCError =>
  new TRPCError({
    code: 'NOT_FOUND',
    message: 'No such execution profile, workspace version or setup bundle version.',
  })

/** Refusal for a name already taken. The name is the caller's own input, so echoing it leaks nothing. */
export const duplicateProfileNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `An execution profile named ${name} already exists. Edit it to publish a new version.`,
  })

/**
 * Refusal for a profile that exists but cannot be acted on in its current state.
 *
 * `CONFLICT` because the request is well-formed and the caller is entitled to make it. Safe to name
 * the state: every caller here is an admin, who may already see every profile (FR-183).
 */
export const profileStateError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** What `create`, `update` and `clone` all answer with. */
export interface PublishedProfile {
  readonly profile: ExecutionProfile
  /** The version this call created. Never an existing one — these procedures only ever insert. */
  readonly version: ExecutionProfileVersion
}

/** What `setEnabled` answers with, so the panel can render a passing gate as well as a refused one. */
export interface ProfileEnableResult {
  readonly profile: ExecutionProfile
  /** The gate's verdict. `undefined` when disabling, which is never gated. */
  readonly check: ProfileEnableCheck | undefined
}

/** Every launch value, as it goes onto a version and onto the trail. */
interface ProfileVersionValues {
  readonly workspaceVersionId: string
  readonly setupBundleVersionId: string
  readonly model: ExecutionProfileVersion['model']
  readonly instanceType: string
  readonly purchaseMode: ExecutionProfileVersion['purchaseMode']
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly defaultWorkflowType: ExecutionProfileVersion['defaultWorkflowType']
  readonly promptPreamble: string | null
  readonly lockedFields: readonly string[]
}

/**
 * Check that the version rows a profile version would pin actually exist.
 *
 * Both are foreign keys, so the alternative to checking is a constraint violation surfacing as an
 * internal error — and the caller cannot tell which of the two ids was wrong from that.
 */
const requirePinnedVersions = async (
  writer: ProfileStoreWriter,
  values: Pick<ProfileVersionValues, 'workspaceVersionId' | 'setupBundleVersionId'>,
): Promise<void> => {
  // The same read the gate makes, which resolves both version rows through their parents. Using it
  // here means "the ids exist" and "the gate can see them" cannot disagree.
  if ((await readProfileEnableSubject(writer, values)) === undefined) {
    throw profileTargetNotFoundError()
  }
}

/** Publish a version and point the profile at it. */
const publishVersion = async (
  writer: ProfileStoreWriter,
  options: {
    readonly executionProfileId: string
    readonly version: number
    readonly createdByUserId: string
    readonly values: ProfileVersionValues
  },
): Promise<PublishedProfile> => {
  const version = await insertProfileVersion(writer, {
    executionProfileId: options.executionProfileId,
    version: options.version,
    createdByUserId: options.createdByUserId,
    ...options.values,
  })

  const profile = await updateProfile(writer, options.executionProfileId, {
    currentVersionId: version.id,
  })

  if (profile === undefined) {
    // Unreachable: the caller has already read or inserted the row inside this transaction.
    throw profileTargetNotFoundError()
  }

  return { profile, version }
}

/** Detail recorded on the trail for a published version. Names configuration, carries no secret. */
const versionAuditDetail = (version: ExecutionProfileVersion): Record<string, unknown> => ({
  version: version.version,
  executionProfileVersionId: version.id,
  workspaceVersionId: version.workspaceVersionId,
  setupBundleVersionId: version.setupBundleVersionId,
  model: version.model,
  instanceType: version.instanceType,
  purchaseMode: version.purchaseMode,
  turnCap: version.turnCap,
  spendCap: version.spendCap,
  defaultWorkflowType: version.defaultWorkflowType,
  lockedFields: version.lockedFields,
})

/** Copy the launch values off an input or an existing version, so the three writers agree. */
const valuesFromVersion = (version: ExecutionProfileVersion): ProfileVersionValues => ({
  workspaceVersionId: version.workspaceVersionId,
  setupBundleVersionId: version.setupBundleVersionId,
  model: version.model,
  instanceType: version.instanceType,
  purchaseMode: version.purchaseMode,
  turnCap: version.turnCap,
  spendCap: version.spendCap,
  defaultWorkflowType: version.defaultWorkflowType,
  promptPreamble: version.promptPreamble,
  lockedFields: version.lockedFields,
})

/**
 * Run the enable gate against a profile — FR-124's validation and 003/FR-065's attachment check.
 *
 * Split out so the two "there is nothing to validate" cases are answered as verdicts rather than as
 * exceptions: the panel renders them in the same list as a disabled bundle, which is what an admin
 * needs — "no published version" is a thing to fix, not an internal error.
 *
 * **The credential-group check runs first and runs unconditionally**, including for a profile with
 * no published version at all. Attachments hang off the mutable `execution_profiles` row rather
 * than off a version (003/FR-062, `db/schema/credential.ts`), so the question "may this profile
 * draw on any capacity" is answerable whether or not there is a version to validate — and an admin
 * building a profile from nothing should be told about both gaps in one attempt rather than about
 * the second only after closing the first.
 */
const runEnableGate = async (
  writer: ProfileStoreWriter & CredentialStoreWriter,
  profile: ExecutionProfile,
): Promise<ProfileEnableCheck> => {
  const attachments = credentialGroupAttachmentCheck(
    await readProfileCredentialGroups(writer, profile.id),
  )

  if (profile.currentVersionId === null) {
    return mergeProfileEnableChecks(attachments, noPublishedVersionCheck())
  }

  const version = await findProfileVersion(writer, profile.currentVersionId)
  if (version === undefined) {
    return mergeProfileEnableChecks(attachments, unreadableSubjectCheck())
  }

  const subject = await readProfileEnableSubject(writer, version)
  if (subject === undefined) {
    return mergeProfileEnableChecks(attachments, unreadableSubjectCheck())
  }

  return mergeProfileEnableChecks(attachments, checkProfileCanBeEnabled(subject))
}

/** `admin.profiles` as it is mounted. */
export const profilesRouter = createTRPCRouter({
  /** Every profile with the version a launch would pin (FR-127). */
  list: adminProcedure.input(listProfilesInput).query(
    async ({ ctx, input }): Promise<Page<ProfileListing>> =>
      listProfiles(ctx.db, {
        enabledOnly: input.enabledOnly,
        includeArchived: input.includeArchived,
        limit: input.limit,
        cursor: input.cursor,
      }),
  ),

  /**
   * Create a profile and publish its first version (FR-121, FR-127).
   *
   * Created **disabled** and granted to nobody. Enabling runs the FR-124 gate; granting is its
   * own separately audited act (FR-184). A profile that arrived enabled would be a launch preset
   * that skipped the one check standing between a preset and a fleet of runs that cannot check
   * out their repositories.
   */
  create: adminProcedure.input(createProfileInput).mutation(
    async ({ ctx, input }): Promise<PublishedProfile> =>
      ctx.db.transaction(async (tx) => {
        const values: ProfileVersionValues = {
          workspaceVersionId: input.workspaceVersionId,
          setupBundleVersionId: input.setupBundleVersionId,
          model: input.model,
          instanceType: input.instanceType,
          purchaseMode: input.purchaseMode,
          turnCap: input.turnCap ?? null,
          spendCap: input.spendCap ?? null,
          defaultWorkflowType: input.defaultWorkflowType,
          promptPreamble: input.promptPreamble ?? null,
          lockedFields: input.lockedFields,
        }

        await requirePinnedVersions(tx, values)

        if ((await findProfileByName(tx, input.name)) !== undefined) {
          throw duplicateProfileNameError(input.name)
        }

        const created = await insertProfile(tx, {
          name: input.name,
          description: input.description,
        })

        const published = await publishVersion(tx, {
          executionProfileId: created.id,
          version: 1,
          createdByUserId: ctx.user.id,
          values,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'execution_profile',
          entityId: published.profile.id,
          entityVersion: 1,
          action: 'registered',
          detail: { name: published.profile.name, ...versionAuditDetail(published.version) },
        })

        return published
      }),
  ),

  /**
   * Edit a profile, which **publishes a new version** (FR-125).
   *
   * Workflows already running keep the version they launched with, so an edit mid-run cannot
   * change the model, the caps or the repositories of a run in flight.
   *
   * Recorded as `replaced` rather than `updated`, because the two are different events: one
   * created an immutable version and the other edited a row in place.
   */
  update: adminProcedure.input(updateProfileInput).mutation(
    async ({ ctx, input }): Promise<PublishedProfile> =>
      ctx.db.transaction(async (tx) => {
        const values: ProfileVersionValues = {
          workspaceVersionId: input.workspaceVersionId,
          setupBundleVersionId: input.setupBundleVersionId,
          model: input.model,
          instanceType: input.instanceType,
          purchaseMode: input.purchaseMode,
          turnCap: input.turnCap ?? null,
          spendCap: input.spendCap ?? null,
          defaultWorkflowType: input.defaultWorkflowType,
          promptPreamble: input.promptPreamble ?? null,
          lockedFields: input.lockedFields,
        }

        await requirePinnedVersions(tx, values)

        const locked = await lockProfileForVersioning(tx, input.executionProfileId)
        if (locked === undefined) {
          throw profileTargetNotFoundError()
        }

        if (locked.profile.archivedAt !== null) {
          throw profileStateError('That execution profile has been archived and cannot be edited.')
        }

        if (input.name !== undefined && input.name !== locked.profile.name) {
          if ((await findProfileByName(tx, input.name)) !== undefined) {
            throw duplicateProfileNameError(input.name)
          }
        }

        const published = await publishVersion(tx, {
          executionProfileId: locked.profile.id,
          version: locked.highestVersion + 1,
          createdByUserId: ctx.user.id,
          values,
        })

        // Name and description live on the parent row, so editing them really is an update. The
        // launch values never are.
        const profile = await updateProfile(tx, locked.profile.id, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description ?? null }),
        })

        if (profile === undefined) {
          throw profileTargetNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'execution_profile',
          entityId: profile.id,
          entityVersion: published.version.version,
          action: 'replaced',
          detail: {
            name: profile.name,
            previousVersion: locked.highestVersion,
            ...versionAuditDetail(published.version),
          },
        })

        return { profile, version: published.version }
      }),
  ),

  /**
   * Copy a profile's current version into a new profile (FR-127).
   *
   * The clone starts disabled at version 1, holding nothing but configuration: no grants are
   * copied, because access is granted to a profile and not inherited by one that resembles it
   * (FR-179, FR-184).
   */
  clone: adminProcedure.input(cloneProfileInput).mutation(
    async ({ ctx, input }): Promise<PublishedProfile> =>
      ctx.db.transaction(async (tx) => {
        const source = await findProfile(tx, input.executionProfileId)
        if (source === undefined) {
          throw profileTargetNotFoundError()
        }

        if (source.currentVersionId === null) {
          throw profileStateError('That execution profile has no published version to clone.')
        }

        const sourceVersion = await findProfileVersion(tx, source.currentVersionId)
        if (sourceVersion === undefined) {
          throw profileTargetNotFoundError()
        }

        if ((await findProfileByName(tx, input.name)) !== undefined) {
          throw duplicateProfileNameError(input.name)
        }

        const created = await insertProfile(tx, {
          name: input.name,
          description: source.description ?? undefined,
        })

        const published = await publishVersion(tx, {
          executionProfileId: created.id,
          version: 1,
          createdByUserId: ctx.user.id,
          values: valuesFromVersion(sourceVersion),
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'execution_profile',
          entityId: published.profile.id,
          entityVersion: 1,
          action: 'registered',
          detail: {
            name: published.profile.name,
            clonedFromExecutionProfileId: source.id,
            clonedFromExecutionProfileVersionId: sourceVersion.id,
            ...versionAuditDetail(published.version),
          },
        })

        return published
      }),
  ),

  /**
   * Enable or disable a profile. **Enabling runs the FR-124 gate** (FR-124, FR-128).
   *
   * The gate reads the bundle and workspace the profile's current version pins, counts that
   * workspace version's entries, checks the profile's credential-group attachments (003/FR-065),
   * and refuses naming what failed. It runs inside the transaction that would flip the
   * flag, so a profile cannot be enabled on the strength of a check taken before a concurrent
   * edit re-pointed it.
   *
   * Disabling is never gated, and a no-op writes no audit entry: nothing changed, and a trail
   * padded with non-events is harder to read.
   */
  setEnabled: adminProcedure.input(setProfileEnabledInput).mutation(
    async ({ ctx, input }): Promise<ProfileEnableResult> =>
      ctx.db.transaction(async (tx) => {
        const existing = await findProfile(tx, input.executionProfileId)
        if (existing === undefined) {
          throw profileTargetNotFoundError()
        }

        if (!input.enabled) {
          if (!existing.enabled) {
            return { profile: existing, check: undefined }
          }

          const disabled = await updateProfile(tx, existing.id, { enabled: false })
          if (disabled === undefined) {
            throw profileTargetNotFoundError()
          }

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'execution_profile',
            entityId: disabled.id,
            action: 'disabled',
          })

          return { profile: disabled, check: undefined }
        }

        const check = await runEnableGate(tx, existing)
        if (!check.passed) {
          throw profileCannotBeEnabledError(check)
        }

        // Already enabled and still passing: report the verdict, write nothing.
        if (existing.enabled) {
          return { profile: existing, check }
        }

        const enabled = await updateProfile(tx, existing.id, { enabled: true })
        if (enabled === undefined) {
          throw profileTargetNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'execution_profile',
          entityId: enabled.id,
          action: 'enabled',
          detail: { validatedAgainstVersionId: existing.currentVersionId },
        })

        return { profile: enabled, check }
      }),
  ),

  /** What would break if this profile went away, and whether it may be archived (FR-128). */
  references: adminProcedure
    .input(profileIdInput)
    .query(async ({ ctx, input }): Promise<ProfileReferences> => {
      if ((await findProfile(ctx.db, input.executionProfileId)) === undefined) {
        throw profileTargetNotFoundError()
      }
      return readProfileReferences(ctx.db, input.executionProfileId)
    }),
})

export type ProfilesRouter = typeof profilesRouter
