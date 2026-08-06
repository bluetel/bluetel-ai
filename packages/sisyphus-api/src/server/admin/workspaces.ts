import { TRPCError } from '@trpc/server'

import type { Workspace } from '../../db'
import {
  cloneWorkspaceInput,
  createWorkspaceInput,
  listWorkspacesInput,
  setWorkspaceEnabledInput,
  updateWorkspaceInput,
  workspaceIdInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import type { Page } from './user-queries'
import { normaliseWorkspaceEntries } from './workspace-entries'
import type {
  PublishedWorkspaceVersion,
  WorkspaceListing,
  WorkspaceReferences,
  WorkspaceStoreWriter,
} from './workspace-store'
import {
  findWorkspace,
  findWorkspaceByName,
  insertWorkspace,
  insertWorkspaceVersion,
  listWorkspaces,
  lockWorkspaceForVersioning,
  readVersionEntries,
  readWorkspaceReferences,
  updateWorkspace,
} from './workspace-store'

/**
 * `admin.workspaces` — the repository set a run checks out (FR-109..FR-111, FR-125, FR-127).
 *
 * ## Editing publishes a version; it does not edit anything
 *
 * `update` inserts a `workspace_versions` row, inserts that version's entries against it, and moves
 * `current_version_id`. It issues no `update` against a version or an entry, and it cannot: the
 * store exports no function that would let it (see `workspace-store.ts`).
 *
 * That is FR-125, and it is not a stylistic preference. A workflow records
 * `workflows.workspace_version_id` at launch and resolves its checkout through it for the rest of
 * its life. A run pinned to version 3 must still resolve version 3's repositories after an admin
 * publishes version 4 halfway through — otherwise the spec's "workspace grows an entry mid-run"
 * case silently changes what a running agent is working on, and FR-065's record of what the run
 * used becomes a description of somebody else's edit. The schema models this correctly by hanging
 * entries off the version; a router that updated entries in place would defeat it while leaving
 * every table and index looking right.
 *
 * `workspaces.test.ts` proves it directly rather than by inspection — that is what the test naming
 * a workflow pinned to version 1 is for.
 *
 * ## Why every procedure is admin-only
 *
 * A workspace names repositories that will be cloned onto an instance holding a credential.
 * Choosing them is configuration, and all configuration is admin-only (FR-127, FR-169). There is no
 * `bundles.list`-shaped exception here: a launch form does not pick a workspace, it picks a
 * **profile**, which pins one.
 *
 * Every act is written to `configuration_audit` with the acting admin, inside the same transaction
 * as the change itself (FR-178).
 */

/**
 * The one refusal for a workspace or version this router cannot act on.
 *
 * `NOT_FOUND` rather than `FORBIDDEN`, and singular for both a missing workspace and a missing
 * version, for the same reason `bundleNotFoundError` is: a refusal that distinguished the two would
 * answer "does this id exist?" for ids the caller has not been shown (FR-190).
 */
export const workspaceNotFoundError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No such workspace or workspace version.' })

/** Refusal for a name already taken. The name is the caller's own input, so echoing it leaks nothing. */
export const duplicateWorkspaceNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `A workspace named ${name} already exists. Edit it to publish a new version.`,
  })

/**
 * Refusal for a workspace that exists but cannot be acted on in its current state.
 *
 * `CONFLICT` because the request is well-formed and the caller is entitled to make it — what is
 * wrong is the target's state. Safe to name that state: every caller here is an admin, who may
 * already see every workspace on the platform (FR-183).
 */
export const workspaceStateError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** What `create`, `update` and `clone` all answer with. */
export interface PublishedWorkspace {
  readonly workspace: Workspace
  /** The version this call created. Never an existing one — these procedures only ever insert. */
  readonly published: PublishedWorkspaceVersion
}

/**
 * Publish a version and point the workspace at it.
 *
 * Extracted because `create`, `update` and `clone` differ only in where the entries come from and
 * what they write to the trail; the versioning itself must not be spelled three ways.
 */
const publishVersion = async (
  writer: WorkspaceStoreWriter,
  options: {
    readonly workspaceId: string
    readonly version: number
    readonly createdByUserId: string
    readonly entries: readonly {
      readonly repositoryUrl: string
      readonly baseBranch: string
      readonly subdirectory: string
      readonly isPrimary: boolean
      readonly position: number
    }[]
  },
): Promise<PublishedWorkspace> => {
  const published = await insertWorkspaceVersion(writer, {
    workspaceId: options.workspaceId,
    version: options.version,
    createdByUserId: options.createdByUserId,
    entries: options.entries,
  })

  const workspace = await updateWorkspace(writer, options.workspaceId, {
    currentVersionId: published.version.id,
  })

  if (workspace === undefined) {
    // Unreachable: the caller has already read or inserted the row inside this transaction.
    throw workspaceNotFoundError()
  }

  return { workspace, published }
}

/** Detail recorded on the trail for a published entry set. Names repositories, carries no secret. */
const versionAuditDetail = (published: PublishedWorkspaceVersion): Record<string, unknown> => ({
  version: published.version.version,
  workspaceVersionId: published.version.id,
  entryCount: published.entries.length,
  entries: published.entries.map((entry) => ({
    repositoryUrl: entry.repositoryUrl,
    baseBranch: entry.baseBranch,
    subdirectory: entry.subdirectory,
    isPrimary: entry.isPrimary,
  })),
})

export const workspacesRouter = createTRPCRouter({
  /** Every workspace with the version a launch would pin, and that version's entries (FR-127). */
  list: adminProcedure.input(listWorkspacesInput).query(
    async ({ ctx, input }): Promise<Page<WorkspaceListing>> =>
      listWorkspaces(ctx.db, {
        enabledOnly: input.enabledOnly,
        includeArchived: input.includeArchived,
        limit: input.limit,
        cursor: input.cursor,
      }),
  ),

  /**
   * Create a workspace and publish its first version (FR-109, FR-127).
   *
   * Created **disabled**. Enabling is a separate, separately audited act, which is what keeps an
   * unreviewed repository set from becoming selectable the moment it is typed in.
   */
  create: adminProcedure.input(createWorkspaceInput).mutation(
    async ({ ctx, input }): Promise<PublishedWorkspace> =>
      ctx.db.transaction(async (tx) => {
        // Normalised before anything is written, so a bad subdirectory costs a retype rather than
        // leaving a parent row behind with no version hanging off it.
        const entries = normaliseWorkspaceEntries(input.entries)

        if ((await findWorkspaceByName(tx, input.name)) !== undefined) {
          throw duplicateWorkspaceNameError(input.name)
        }

        const created = await insertWorkspace(tx, {
          name: input.name,
          description: input.description,
        })

        const { workspace, published } = await publishVersion(tx, {
          workspaceId: created.id,
          version: 1,
          createdByUserId: ctx.user.id,
          entries,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'workspace',
          entityId: workspace.id,
          entityVersion: published.version.version,
          action: 'registered',
          detail: { name: workspace.name, ...versionAuditDetail(published) },
        })

        return { workspace, published }
      }),
  ),

  /**
   * Edit a workspace, which **publishes a new version** (FR-125).
   *
   * The whole entry list is submitted rather than a patch, and it becomes version n+1 with its own
   * entry rows. Nothing about version n changes, so a workflow that pinned it keeps resolving the
   * repositories it started with — including one that has been removed from the workspace since.
   *
   * The workspace row is locked first, so two concurrent edits queue rather than both computing the
   * same next version number; see `lockWorkspaceForVersioning`.
   *
   * Recorded as `replaced` rather than `updated`, because the two are different events: one created
   * an immutable version and the other edited a row in place.
   */
  update: adminProcedure.input(updateWorkspaceInput).mutation(
    async ({ ctx, input }): Promise<PublishedWorkspace> =>
      ctx.db.transaction(async (tx) => {
        const entries = normaliseWorkspaceEntries(input.entries)

        const locked = await lockWorkspaceForVersioning(tx, input.workspaceId)
        if (locked === undefined) {
          throw workspaceNotFoundError()
        }

        if (locked.workspace.archivedAt !== null) {
          throw workspaceStateError('That workspace has been archived and cannot be edited.')
        }

        if (input.name !== undefined && input.name !== locked.workspace.name) {
          const clash = await findWorkspaceByName(tx, input.name)
          if (clash !== undefined) {
            throw duplicateWorkspaceNameError(input.name)
          }
        }

        const { published } = await publishVersion(tx, {
          workspaceId: locked.workspace.id,
          version: locked.highestVersion + 1,
          createdByUserId: ctx.user.id,
          entries,
        })

        // Name and description live on the parent row, so editing them really is an update. The
        // entry set never is.
        const updated = await updateWorkspace(tx, locked.workspace.id, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description ?? null }),
        })

        if (updated === undefined) {
          throw workspaceNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'workspace',
          entityId: updated.id,
          entityVersion: published.version.version,
          action: 'replaced',
          detail: {
            name: updated.name,
            previousVersion: locked.highestVersion,
            ...versionAuditDetail(published),
          },
        })

        return { workspace: updated, published }
      }),
  ),

  /**
   * Copy a workspace's current entry set into a new workspace (FR-127).
   *
   * The clone starts at version 1 and **disabled**, and it copies the version the original points
   * at rather than its newest — cloning something an admin has not published would hand them a copy
   * of a draft they never saw.
   */
  clone: adminProcedure.input(cloneWorkspaceInput).mutation(
    async ({ ctx, input }): Promise<PublishedWorkspace> =>
      ctx.db.transaction(async (tx) => {
        const source = await findWorkspace(tx, input.workspaceId)
        if (source === undefined) {
          throw workspaceNotFoundError()
        }

        if (source.currentVersionId === null) {
          throw workspaceStateError('That workspace has no published version to clone.')
        }

        if ((await findWorkspaceByName(tx, input.name)) !== undefined) {
          throw duplicateWorkspaceNameError(input.name)
        }

        const sourceEntries = await readVersionEntries(tx, source.currentVersionId)
        if (sourceEntries.length === 0) {
          throw workspaceStateError('That workspace version has no repositories to clone.')
        }

        const created = await insertWorkspace(tx, {
          name: input.name,
          description: source.description ?? undefined,
        })

        const { workspace, published } = await publishVersion(tx, {
          workspaceId: created.id,
          version: 1,
          createdByUserId: ctx.user.id,
          entries: sourceEntries.map((entry) => ({
            repositoryUrl: entry.repositoryUrl,
            baseBranch: entry.baseBranch,
            subdirectory: entry.subdirectory,
            isPrimary: entry.isPrimary,
            position: entry.position,
          })),
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'workspace',
          entityId: workspace.id,
          entityVersion: 1,
          action: 'registered',
          detail: {
            name: workspace.name,
            clonedFromWorkspaceId: source.id,
            clonedFromWorkspaceVersionId: source.currentVersionId,
            ...versionAuditDetail(published),
          },
        })

        return { workspace, published }
      }),
  ),

  /**
   * Enable or disable a workspace (FR-127, FR-128).
   *
   * Disabling is what FR-128 offers **instead of** deletion, and it deliberately does not consult
   * `references`: a workspace with a run in flight is exactly the one an admin most needs to be
   * able to take out of circulation, and disabling does not affect runs already under way.
   *
   * Enabling a workspace with no published version is refused, because it would appear in a picker
   * offering a launch that would then be refused — a form that lies to the person filling it in.
   */
  setEnabled: adminProcedure.input(setWorkspaceEnabledInput).mutation(
    async ({ ctx, input }): Promise<Workspace> =>
      ctx.db.transaction(async (tx) => {
        const existing = await findWorkspace(tx, input.workspaceId)
        if (existing === undefined) {
          throw workspaceNotFoundError()
        }

        if (input.enabled && existing.currentVersionId === null) {
          throw workspaceStateError(
            'That workspace has no published version, so it cannot be enabled.',
          )
        }

        // A no-op still returns the row, but writes no audit entry: nothing changed, so there is
        // nothing to record, and a trail padded with non-events is harder to read.
        if (existing.enabled === input.enabled) {
          return existing
        }

        const updated = await updateWorkspace(tx, input.workspaceId, { enabled: input.enabled })
        if (updated === undefined) {
          throw workspaceNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'workspace',
          entityId: updated.id,
          action: input.enabled ? 'enabled' : 'disabled',
        })

        return updated
      }),
  ),

  /** What would break if this workspace went away, and whether it may be archived (FR-128). */
  references: adminProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }): Promise<WorkspaceReferences> => {
      if ((await findWorkspace(ctx.db, input.workspaceId)) === undefined) {
        throw workspaceNotFoundError()
      }
      return readWorkspaceReferences(ctx.db, input.workspaceId)
    }),
})

export type WorkspacesRouter = typeof workspacesRouter
