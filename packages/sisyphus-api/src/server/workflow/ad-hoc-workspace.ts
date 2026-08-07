import { TRPCError } from '@trpc/server'
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import type { SisyphusDatabase, WorkflowEntry } from '../../db'
import { uuidV7, workflowEntries, workspaceEntries, workspaces, workspaceVersions } from '../../db'
import type { AdHocWorkspaceInput } from '../../schemas'

import { adHocWorkspaceName, deriveSubdirectory } from './ad-hoc-plan'

/**
 * What an ad hoc run checks out (FR-114, FR-125, FR-129).
 *
 * The launch form offers two answers to one question — an existing workspace, or a repository and
 * a base branch typed in — and both have to end as a `workspace_versions` row, because
 * `workflows.workspace_version_id` is not null. That is not an inconvenience to work around: a run
 * that cannot name the immutable entry set it started from cannot be reproduced six months later,
 * and FR-065 asks for exactly that.
 *
 * So the second answer is **materialised** rather than special-cased. A hand-entered repository
 * becomes a private workspace with one version and one primary entry, created disabled so it never
 * appears in the picker as though somebody had curated it. Everything downstream — the entry copy,
 * the executor's checkout, the multi-repo machinery in FR-114 — then sees one shape.
 */

/** Anything that can run this module's statements — the pooled handle or a transaction on it. */
export type WorkspaceWriter = Pick<SisyphusDatabase, 'select' | 'insert'>

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty and a `=== undefined` guard is narrowed away as unreachable.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** The workspace version named does not exist, or belongs to a workspace that is gone. */
export const workspaceNotAvailableError = (): TRPCError =>
  new TRPCError({ code: 'NOT_FOUND', message: 'No such workspace version.' })

/**
 * The workspace exists but cannot start a run right now.
 *
 * `CONFLICT` rather than `NOT_FOUND`, and safe to be distinguishable here: every caller of this
 * module is an admin, who may already see every workspace in the platform (FR-183), so naming the
 * state discloses nothing. The distinction is what lets the form say "enable it" instead of
 * "check the id".
 */
export const workspaceNotLaunchableError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** One selectable workspace, as the ad hoc launch form's picker needs it. */
export interface LaunchableWorkspace {
  readonly id: string
  readonly name: string
  readonly description: string | null
  /** The version a launch would pin. Never null — an unpublished workspace is not listed. */
  readonly currentVersionId: string
  readonly entryCount: number
}

/**
 * The workspaces an ad hoc launch may choose from (FR-016).
 *
 * Enabled, unarchived, and holding a published version with at least one entry. All four
 * conditions are here rather than in the resolver, because "only enabled workspaces are
 * selectable" is a property of the *list* — a picker that offered a workspace the launch would
 * then refuse is a form that lies to the person filling it in.
 *
 * The by-product workspaces this module materialises are created disabled, so they never surface
 * here. That is what keeps a picker from filling up with one row per hand-entered launch.
 */
export const listLaunchableWorkspaces = async (
  db: Pick<SisyphusDatabase, 'select'>,
): Promise<readonly LaunchableWorkspace[]> => {
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      description: workspaces.description,
      currentVersionId: workspaceVersions.id,
      entryCount: sql<string>`count(${workspaceEntries.id})`,
    })
    .from(workspaces)
    .innerJoin(workspaceVersions, eq(workspaceVersions.id, workspaces.currentVersionId))
    .innerJoin(workspaceEntries, eq(workspaceEntries.workspaceVersionId, workspaceVersions.id))
    .where(
      and(
        eq(workspaces.enabled, true),
        isNull(workspaces.archivedAt),
        isNotNull(workspaces.currentVersionId),
      ),
    )
    .groupBy(workspaces.id, workspaces.name, workspaces.description, workspaceVersions.id)
    .orderBy(asc(workspaces.name))

  return rows.map(
    (row): LaunchableWorkspace => ({
      id: row.id,
      name: row.name,
      description: row.description,
      currentVersionId: row.currentVersionId,
      entryCount: Number(row.entryCount),
    }),
  )
}

/**
 * Check that a named workspace version can actually start a run.
 *
 * Read through the version rather than through the workspace's `current_version_id`: the form
 * submits the version it displayed, and re-reading the pointer here would silently launch against
 * a version published between the page loading and the button being pressed (FR-125).
 */
export const requireLaunchableWorkspaceVersion = async (
  writer: WorkspaceWriter,
  workspaceVersionId: string,
): Promise<string> => {
  const row = firstRow(
    await writer
      .select({
        id: workspaceVersions.id,
        enabled: workspaces.enabled,
        archivedAt: workspaces.archivedAt,
      })
      .from(workspaceVersions)
      .innerJoin(workspaces, eq(workspaces.id, workspaceVersions.workspaceId))
      .where(eq(workspaceVersions.id, workspaceVersionId))
      .limit(1),
  )

  if (row === undefined) {
    throw workspaceNotAvailableError()
  }

  if (row.archivedAt !== null) {
    throw workspaceNotLaunchableError('That workspace has been archived.')
  }

  if (!row.enabled) {
    throw workspaceNotLaunchableError('That workspace is disabled and cannot start runs.')
  }

  return row.id
}

/**
 * Turn a hand-entered repository into a workspace version (FR-129, FR-187).
 *
 * Created **disabled**, on purpose. FR-124 makes enabling conditional on validation confirming the
 * repositories and branches are reachable, and nothing has validated this one — the admin typed it
 * thirty seconds ago. Leaving it disabled means it is a record of what this run checked out
 * without also being an offer to launch on it again unchecked.
 *
 * The entry is `is_primary`, because skills and the result branch resolve from the primary entry
 * (FR-110) and a single-repository workspace with no primary would leave the executor with nowhere
 * to read them from.
 */
export const materialiseRepositoryWorkspace = async (
  writer: WorkspaceWriter,
  options: {
    readonly repositoryUrl: string
    readonly baseBranch: string
    readonly actorUserId: string
  },
): Promise<string> => {
  const workspaceId = uuidV7()

  await writer.insert(workspaces).values({
    id: workspaceId,
    name: adHocWorkspaceName(options.repositoryUrl, workspaceId),
    description: 'Created by an ad hoc launch. Not validated, and not offered in the picker.',
    enabled: false,
  })

  const versionId = uuidV7()
  await writer.insert(workspaceVersions).values({
    id: versionId,
    workspaceId,
    version: 1,
    createdByUserId: options.actorUserId,
  })

  await writer.insert(workspaceEntries).values({
    workspaceVersionId: versionId,
    repositoryUrl: options.repositoryUrl,
    baseBranch: options.baseBranch,
    subdirectory: deriveSubdirectory(options.repositoryUrl),
    isPrimary: true,
    position: 1,
  })

  return versionId
}

/** Which of the two answers the launch gave, and the version it resolved to. */
export interface ResolvedAdHocWorkspace {
  readonly workspaceVersionId: string
  /** True when a private workspace was created for this run rather than an existing one chosen. */
  readonly materialised: boolean
}

/**
 * Resolve the launch form's workspace answer to a version id.
 *
 * @param writer - The transaction the whole launch runs in. Materialisation must roll back with
 *   the workflow insert, or a refused launch would leave an orphan workspace behind.
 */
export const resolveAdHocWorkspace = async (
  writer: WorkspaceWriter,
  options: { readonly workspace: AdHocWorkspaceInput; readonly actorUserId: string },
): Promise<ResolvedAdHocWorkspace> => {
  const { workspace, actorUserId } = options

  if (workspace.source === 'workspace') {
    return {
      workspaceVersionId: await requireLaunchableWorkspaceVersion(
        writer,
        workspace.workspaceVersionId,
      ),
      materialised: false,
    }
  }

  return {
    workspaceVersionId: await materialiseRepositoryWorkspace(writer, {
      repositoryUrl: workspace.repositoryUrl,
      baseBranch: workspace.baseBranch,
      actorUserId,
    }),
    materialised: true,
  }
}

/**
 * Copy the pinned workspace version's entries onto the run (FR-114, FR-125).
 *
 * The run holds its own copy rather than joining back to the workspace, so an entry added or
 * removed later cannot change what a finished run says it checked out.
 */
export const copyWorkspaceEntries = async (
  writer: WorkspaceWriter,
  options: { readonly workflowId: string; readonly workspaceVersionId: string },
): Promise<readonly WorkflowEntry[]> => {
  const entries = await writer
    .select()
    .from(workspaceEntries)
    .where(eq(workspaceEntries.workspaceVersionId, options.workspaceVersionId))
    .orderBy(asc(workspaceEntries.position))

  if (entries.length === 0) {
    // Discovering this at phase 6 would mean the run has already paid for an instance.
    throw workspaceNotLaunchableError('That workspace version has no repositories.')
  }

  return writer
    .insert(workflowEntries)
    .values(
      entries.map((entry) => ({
        workflowId: options.workflowId,
        workspaceEntryId: entry.id,
        repositoryUrl: entry.repositoryUrl,
        baseBranch: entry.baseBranch,
        subdirectory: entry.subdirectory,
        isPrimary: entry.isPrimary,
      })),
    )
    .returning()
}
