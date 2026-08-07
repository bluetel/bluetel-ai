import type { SQL } from 'drizzle-orm'
import { and, asc, desc, eq, gte, lte, sql, sum } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Artifact, LogSegment, SisyphusDatabase, Workflow, WorkflowEntry } from '../../db'
import {
  artifacts,
  executionProfiles,
  executionProfileVersions,
  integrations,
  logSegments,
  users,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { ListWorkflowsInput, SpendSummaryInput } from '../../schemas'
import type { ResolvedScope, ScopedReadOptions } from '../scope'
import { requireWorkflowInScope, scopedWorkflowWhere } from '../scope'

import type { WorkflowPage } from './filters'
import { toWorkflowPage, workflowListConditions } from './filters'
import type { LaunchConfiguration } from './launch-configuration'
import { loadLaunchConfiguration } from './launch-configuration'
import type { StoragePark } from './storage-park'
import { readStoragePark } from './storage-park'
import { isWatching } from './watch'

/**
 * **Every workflow read path (T041).**
 *
 * There is exactly one rule in this file and it is applied without exception: no statement that
 * touches `workflows` is issued without `scopedWorkflowWhere` or `requireWorkflowInScope` in front
 * of it — and that includes the counts and the spend aggregate. FR-190 forbids disclosing a
 * workflow **including its existence**, so a total that summed an invisible run would disclose it
 * exactly as effectively as returning the row (data-model.md → Access scoping, SC-051).
 *
 * The scoping is written **into** these queries rather than laid over them afterwards, because a
 * scoping pass is a review artefact and this has to be a structural one: an unscoped read here
 * does not fail, it silently answers.
 *
 * ## The child tables
 *
 * `workflow_events`, `log_segments`, `artifacts` and `workflow_entries` have no scope predicate of
 * their own and must not grow one — that would be the per-resolver re-derivation the base selector
 * exists to prevent. Instead every one of them is reached **through** `requireWorkflowInScope`,
 * which either yields the parent workflow or throws the single `NOT_FOUND` that an out-of-scope id
 * and a nonexistent id are indistinguishable under. A caller who cannot see the run cannot see one
 * byte of its log, and cannot tell whether the run exists.
 *
 * ## Staying responsive at volume
 *
 * The list is keyset-paginated on the primary key with a `limit + 1` over-fetch — never an offset,
 * and never a companion `count(*)`. Ids are UUID v7, so `order by id desc` **is** newest-first and
 * the cursor is a row the caller has been shown. See `./filters.ts` for how each filter is kept on
 * an index (FR-012, FR-013).
 */

/**
 * The first row, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed as present even when the
 * result set is empty, and a `=== undefined` guard against it is narrowed away as unreachable.
 * Going through a function whose *declared* return type admits `undefined` restores the check.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/** The initiating user, joined under a distinct name so the owner join can also be `users`. */
const initiator = alias(users, 'initiator')
/** The accountable owner. Always present — `owner_user_id` is not null (FR-132). */
const owner = alias(users, 'owner')

/**
 * One row of the panel's primary list (FR-012).
 *
 * Carries the *names* the row displays rather than bare ids, because a list that renders ids is
 * not the list FR-012 describes, and resolving them client-side would be one request per row.
 *
 * **Duration is not a column and is not computed here.** No `started_at`/`ended_at` pair is
 * modelled on `workflows`; `createdAt` is when the run was launched and `updatedAt` is when it
 * last moved, so the panel renders `updatedAt - createdAt` for a settled run and `now - createdAt`
 * for a live one. Deriving it in SQL would mean a correlated read of `workflow_events` per row,
 * which is precisely the per-row work FR-013's responsiveness clause rules out.
 */
export interface WorkflowListing {
  readonly id: string
  readonly type: Workflow['type']
  readonly state: Workflow['state']
  readonly terminalOutcome: Workflow['terminalOutcome']
  readonly ticketReference: string | null
  readonly model: Workflow['model']
  readonly turnsUsed: number
  readonly spendUsed: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly initiatedByUserId: string | null
  readonly initiatedByDisplayName: string | null
  readonly ownerUserId: string
  readonly ownerDisplayName: string
  readonly originatingIntegrationId: string | null
  readonly originatingIntegrationName: string | null
  readonly executionProfileId: string | null
  /**
   * The profile's name **as it stands now** — a display name, never a launch value.
   *
   * Read from the mutable parent row on purpose: an operator scanning the list recognises the
   * profile by what it is called today. What the run was *configured* with is a different question,
   * and {@link WorkflowListing.executionProfileVersion} is the field that keeps the two from being
   * confused — see `./launch-configuration.ts`.
   */
  readonly executionProfileName: string | null
  /** The profile version the run pinned (FR-126). Null when it was launched ad hoc. */
  readonly executionProfileVersion: number | null
  /** The workspace, not its repositories: FR-012 says identify the set, not enumerate it. */
  readonly workspaceId: string
  readonly workspaceName: string
}

/** The pinned profile version, joined for its number. Aliased so the name it carries is unmistakable. */
const pinnedProfileVersion = alias(executionProfileVersions, 'pinned_profile_version')

const workflowListingColumns = {
  id: workflows.id,
  type: workflows.type,
  state: workflows.state,
  terminalOutcome: workflows.terminalOutcome,
  ticketReference: workflows.ticketReference,
  model: workflows.model,
  turnsUsed: workflows.turnsUsed,
  spendUsed: workflows.spendUsed,
  createdAt: workflows.createdAt,
  updatedAt: workflows.updatedAt,
  initiatedByUserId: workflows.initiatedByUserId,
  initiatedByDisplayName: initiator.displayName,
  ownerUserId: workflows.ownerUserId,
  ownerDisplayName: owner.displayName,
  originatingIntegrationId: workflows.originatingIntegrationId,
  originatingIntegrationName: integrations.name,
  executionProfileId: workflows.executionProfileId,
  executionProfileName: executionProfiles.name,
  executionProfileVersion: pinnedProfileVersion.version,
  workspaceId: workspaces.id,
  workspaceName: workspaces.name,
} as const

/**
 * The panel's primary read (FR-012, FR-013, FR-190).
 *
 * Scope first, filters second, keyset third. The caller's filters are composed *inside*
 * `scopedWorkflowWhere`, so no combination of them can widen the result set beyond the visible
 * one — the worst a hostile filter can do is match nothing.
 */
export const listWorkflows = async (
  options: ScopedReadOptions & { readonly input: ListWorkflowsInput },
): Promise<WorkflowPage<WorkflowListing>> => {
  const { db, scope, input } = options

  const rows = await db
    .select(workflowListingColumns)
    .from(workflows)
    .innerJoin(owner, eq(owner.id, workflows.ownerUserId))
    .leftJoin(initiator, eq(initiator.id, workflows.initiatedByUserId))
    .leftJoin(integrations, eq(integrations.id, workflows.originatingIntegrationId))
    // Two joins onto the profile, and the difference between them is the point: `executionProfiles`
    // is the mutable parent, joined for the name the row displays, while `pinnedProfileVersion` is
    // keyed on the version the run recorded and is the only thing here that says what it ran with.
    .leftJoin(executionProfiles, eq(executionProfiles.id, workflows.executionProfileId))
    .leftJoin(
      pinnedProfileVersion,
      eq(pinnedProfileVersion.id, workflows.executionProfileVersionId),
    )
    .innerJoin(workspaceVersions, eq(workspaceVersions.id, workflows.workspaceVersionId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceVersions.workspaceId))
    .where(scopedWorkflowWhere(scope, workflowListConditions(db, input)))
    .orderBy(desc(workflows.id))
    .limit(input.limit + 1)

  return toWorkflowPage(rows, input.limit)
}

/** The workflow detail view (FR-014). */
export interface WorkflowDetail {
  readonly workflow: Workflow
  readonly entries: readonly WorkflowEntry[]
  readonly ownerDisplayName: string
  readonly initiatedByDisplayName: string | null
  /** The profile's name as it stands now. A display name — see {@link WorkflowDetail.launchConfiguration}. */
  readonly executionProfileName: string | null
  readonly originatingIntegrationName: string | null
  readonly workspaceId: string
  readonly workspaceName: string
  /**
   * What the run was launched with, reconstructed from the versions it pinned (SC-021).
   *
   * Resolved through `workflows.execution_profile_version_id` rather than through the profile's
   * current version, so a run launched under version 3 still reads back as version 3 after the
   * profile has been edited seven times. `./launch-configuration.ts` states which fields come from
   * the pin and which from the live row, and separates them in the type.
   */
  readonly launchConfiguration: LaunchConfiguration
  /**
   * Whether **the caller** currently follows this run (FR-138).
   *
   * A field on the detail read rather than a procedure of its own, and the reason is FR-190 rather
   * than convenience. `watch`/`unwatch` are two mutations that already answer `NOT_FOUND`
   * indistinguishably for an out-of-scope run and a nonexistent one; a third id-taking *read* would
   * be a third place that rule has to be re-derived, and the failure mode when it is got wrong is
   * silence — an `isWatching` procedure that answered `false` for a workflow the caller may not see
   * has said the workflow exists. Riding on `byId` means the answer is only ever computed for an id
   * `requireWorkflowInScope` has already admitted, so the disclosure is structurally impossible
   * rather than checked.
   *
   * It is also the request the panel is already making: the Watch/Unwatch control lives on the
   * detail view, so this costs one extra indexed lookup on a query that has run anyway, instead of
   * a second round trip that would render the control in the wrong state until it landed.
   *
   * Always the caller's own — `scope.userId`, never a parameter. There is no input field for whose
   * watch this is, so "am I following it?" cannot become "is Alice following it?".
   */
  readonly watching: boolean
  /**
   * The run's latest snapshot park, or null if it has never parked (FR-082).
   *
   * Rides on the detail read for the same reason {@link WorkflowDetail.watching} does: it is wanted
   * on exactly the screen this read already serves, and a second id-taking read would be a second
   * place FR-190's scope rule has to hold. `storagePark.waiting` is what lets the panel say the run
   * is **waiting on storage** rather than render a live run holding at a turn boundary as though it
   * had stalled. See `./storage-park.ts` for how the end of a park is derived rather than reported.
   */
  readonly storagePark: StoragePark | null
}

/**
 * Read one workflow with what the detail view names it by (FR-014).
 *
 * `requireWorkflowInScope` runs **first** and everything after it is keyed on an id the caller has
 * been shown to be allowed to see. Out of scope and nonexistent both leave here as the same
 * `NOT_FOUND` with the same message, so the procedure is not an oracle for enumerating ids.
 */
export const readWorkflowDetail = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<WorkflowDetail> => {
  const workflow = await requireWorkflowInScope(options)
  const { db } = options

  const naming = firstRow(
    await db
      .select({
        ownerDisplayName: owner.displayName,
        initiatedByDisplayName: initiator.displayName,
        executionProfileName: executionProfiles.name,
        originatingIntegrationName: integrations.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(workflows)
      .innerJoin(owner, eq(owner.id, workflows.ownerUserId))
      .leftJoin(initiator, eq(initiator.id, workflows.initiatedByUserId))
      .leftJoin(executionProfiles, eq(executionProfiles.id, workflows.executionProfileId))
      .leftJoin(integrations, eq(integrations.id, workflows.originatingIntegrationId))
      .innerJoin(workspaceVersions, eq(workspaceVersions.id, workflows.workspaceVersionId))
      .innerJoin(workspaces, eq(workspaces.id, workspaceVersions.workspaceId))
      // Scoped again rather than reduced to `eq(id, …)`. Composing the base selector costs
      // nothing and means no statement in this file can be copied into a new resolver already
      // unscoped.
      .where(scopedWorkflowWhere(options.scope, eq(workflows.id, workflow.id)))
      .limit(1),
  )

  const entries = await db
    .select()
    .from(workflowEntries)
    .where(eq(workflowEntries.workflowId, workflow.id))
    .orderBy(asc(workflowEntries.id))

  // Issued separately rather than folded into the naming query above, because it answers a
  // different question with different rows: the query above reads what things are *called*, and
  // this reads what the run *ran with*. Keeping them apart is what stops the pinned version being
  // quietly re-derived from the live profile the next time this select is edited (SC-021).
  const launchConfiguration = await loadLaunchConfiguration(db, workflow)

  // Reached only after `requireWorkflowInScope` has admitted the id, and keyed on the resolved
  // scope's own user — so it can neither confirm an out-of-scope run nor report somebody else's
  // watch. `isWatching` is `../workflow/watch.ts`'s, so there is one definition of what a watch is.
  const watching = await isWatching(db, { workflowId: workflow.id, userId: options.scope.userId })

  // Same gating as everything above it: keyed on the row `requireWorkflowInScope` returned, and
  // reading only `workflow_events`, which carries no scope predicate of its own and must not grow
  // one. The panel needs it on the first paint — a run that is waiting on storage has to say so
  // before an operator concludes it has hung (FR-082).
  const storagePark = await readStoragePark(db, workflow)

  return {
    workflow,
    entries,
    ownerDisplayName: naming?.ownerDisplayName ?? '',
    initiatedByDisplayName: naming?.initiatedByDisplayName ?? null,
    executionProfileName: naming?.executionProfileName ?? null,
    originatingIntegrationName: naming?.originatingIntegrationName ?? null,
    workspaceId: naming?.workspaceId ?? '',
    workspaceName: naming?.workspaceName ?? '',
    launchConfiguration,
    watching,
    storagePark,
  }
}

/** One entry of the append-only lifecycle timeline (FR-014, FR-064). */
export interface TimelineEntry {
  readonly id: string
  readonly event: string
  readonly actorType: string
  readonly actorUserId: string | null
  readonly actorDisplayName: string | null
  readonly detail: unknown
  readonly createdAt: Date
}

/**
 * The timeline, oldest first (FR-014, FR-064).
 *
 * Gated on the parent workflow, then read straight off `workflow_events_workflow_idx`. Oldest
 * first because it is a narrative: a reader wants "provisioned, started, corrected, capped" in
 * that order, not reversed.
 */
export const readTimeline = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<readonly TimelineEntry[]> => {
  const workflow = await requireWorkflowInScope(options)

  return options.db
    .select({
      id: workflowEvents.id,
      event: workflowEvents.event,
      actorType: workflowEvents.actorType,
      actorUserId: workflowEvents.actorUserId,
      actorDisplayName: users.displayName,
      detail: workflowEvents.detail,
      createdAt: workflowEvents.createdAt,
    })
    .from(workflowEvents)
    .leftJoin(users, eq(users.id, workflowEvents.actorUserId))
    .where(eq(workflowEvents.workflowId, workflow.id))
    .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id))
}

/**
 * Log segments from `fromSequence` onward (FR-046).
 *
 * Incremental by design: the panel holds what it has already rendered and asks only for what
 * follows, so a long run does not re-transfer its whole log on every poll. Ordered by `sequence`
 * rather than by arrival, which is what makes the log continuous across a resumption.
 */
export const readLogSegments = async (
  options: ScopedReadOptions & {
    readonly workflowId: string
    readonly fromSequence: number
  },
): Promise<readonly LogSegment[]> => {
  const workflow = await requireWorkflowInScope(options)

  return options.db
    .select()
    .from(logSegments)
    .where(
      and(eq(logSegments.workflowId, workflow.id), gte(logSegments.sequence, options.fromSequence)),
    )
    .orderBy(asc(logSegments.sequence))
}

/**
 * Everything the run produced (FR-014, SC-012).
 *
 * An artifact whose object has expired is still listed, with its `expiresAt`, rather than
 * vanishing — so a gap in the record reads as retention rather than as loss.
 */
export const readArtifacts = async (
  options: ScopedReadOptions & { readonly workflowId: string },
): Promise<readonly Artifact[]> => {
  const workflow = await requireWorkflowInScope(options)

  return options.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.workflowId, workflow.id))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
}

/** One grouped spend total (FR-156, SC-051). */
export interface SpendGroup {
  readonly groupId: string | null
  readonly groupLabel: string | null
  readonly workflowCount: number
  readonly spendTotal: string
  readonly turnsTotal: number
}

/** The whole answer: the groups plus the scoped total they sum to. */
export interface SpendSummary {
  readonly groups: readonly SpendGroup[]
  readonly workflowCount: number
  readonly spendTotal: string
  readonly turnsTotal: number
}

/**
 * What each grouping keys on.
 *
 * `client` maps to the **originating integration**: no client entity is modelled, and the
 * integration is the platform's one per-customer boundary — one board, one credential set, one
 * default owner. Grouping a manually-started run under a null client is honest; inventing a
 * client from the workspace name would not be.
 */
const spendGroupings = {
  client: { id: workflows.originatingIntegrationId, label: integrations.name },
  workspace: { id: workspaces.id, label: workspaces.name },
  /**
   * The **profile**, not the profile version — and deliberately so, unlike the reads above.
   *
   * A spend total is a question about a cost centre over time, and a profile edited three times in
   * a quarter is one cost centre, not four. Grouping on the pinned version would split a client's
   * bill across every edit anybody made to their preset, which is the opposite of what FR-156 asks
   * for. So the mutable parent row is the right join here; what a given run was configured with is
   * `./launch-configuration.ts`, per run, and is not a question an aggregate can answer.
   */
  profile: { id: workflows.executionProfileId, label: executionProfiles.name },
  user: { id: workflows.ownerUserId, label: owner.displayName },
} as const

/** Numeric aggregates arrive as strings or null; normalise once rather than at every call site. */
const asCount = (value: string | null): number => Number(value ?? 0)

/**
 * Spend, grouped and **scoped** (FR-156, FR-190, SC-051).
 *
 * This is the aggregate the leak contract is most easily broken on, because an aggregate looks
 * like a number rather than like data: a total that included a workflow the caller may not see
 * would disclose that it exists, and would do so without ever naming it. It therefore composes
 * from the identical base selector the row reads do — the `where` below is the same
 * `scopedWorkflowWhere` call, not a re-derivation of it.
 *
 * The date window is half-open on `created_at`, so "since Monday" and "everything" are the same
 * query shape.
 */
export const summariseSpend = async (
  options: ScopedReadOptions & { readonly input: SpendSummaryInput },
): Promise<SpendSummary> => {
  const { db, scope, input } = options
  const grouping = spendGroupings[input.groupBy]

  const windowConditions: readonly (SQL | undefined)[] = [
    input.from === undefined ? undefined : gte(workflows.createdAt, input.from),
    input.to === undefined ? undefined : lte(workflows.createdAt, input.to),
  ]
  const where = scopedWorkflowWhere(scope, ...windowConditions)

  const rows = await db
    .select({
      groupId: grouping.id,
      groupLabel: grouping.label,
      workflowCount: sql<string>`count(*)`,
      spendTotal: sum(workflows.spendUsed),
      turnsTotal: sum(workflows.turnsUsed),
    })
    .from(workflows)
    .innerJoin(owner, eq(owner.id, workflows.ownerUserId))
    .leftJoin(integrations, eq(integrations.id, workflows.originatingIntegrationId))
    .leftJoin(executionProfiles, eq(executionProfiles.id, workflows.executionProfileId))
    .innerJoin(workspaceVersions, eq(workspaceVersions.id, workflows.workspaceVersionId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceVersions.workspaceId))
    .where(where)
    .groupBy(grouping.id, grouping.label)
    .orderBy(desc(sum(workflows.spendUsed)))

  const groups = rows.map(
    (row): SpendGroup => ({
      groupId: row.groupId,
      groupLabel: row.groupLabel,
      workflowCount: asCount(row.workflowCount),
      spendTotal: row.spendTotal ?? '0',
      turnsTotal: asCount(row.turnsTotal),
    }),
  )

  // The overall figure is folded from the scoped groups rather than issued as a second, separately
  // scoped query. One `where` means the total and its parts cannot disagree, and there is no
  // second statement for a future edit to leave unscoped.
  return {
    groups,
    workflowCount: groups.reduce((total, group) => total + group.workflowCount, 0),
    spendTotal: groups.reduce((total, group) => total + Number(group.spendTotal), 0).toFixed(4),
    turnsTotal: groups.reduce((total, group) => total + group.turnsTotal, 0),
  }
}

/**
 * Count workflows the caller may see, optionally narrowed by the list filters.
 *
 * Exposed because the panel's "N runs match" badge must be built from *this* rather than from a
 * hand-written `count(*)`: an unscoped total is the same disclosure as an unscoped row, and it is
 * the one a reviewer is least likely to notice (FR-190).
 */
export const countVisibleWorkflows = async (
  options: ScopedReadOptions & { readonly input: ListWorkflowsInput },
): Promise<number> => {
  const row = firstRow(
    await options.db
      .select({ value: sql<string>`count(*)` })
      .from(workflows)
      .where(
        scopedWorkflowWhere(
          options.scope,
          // The cursor is a pagination device, not a filter; a count that honoured it would
          // shrink as the caller paged.
          workflowListConditions(options.db, { ...options.input, cursor: undefined }),
        ),
      ),
  )

  return asCount(row?.value ?? null)
}

/**
 * Re-exported so a caller that needs the raw handle and scope pair does not import two modules —
 * and so nothing is tempted to build the pair by hand.
 */
export type { ResolvedScope, ScopedReadOptions, SisyphusDatabase }
