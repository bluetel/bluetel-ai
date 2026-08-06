import { randomUUID } from 'node:crypto'

import type { IntegrationMapping as ContractMapping } from '@bluetel-ai/sisyphus-api/contracts'
import type {
  Integration,
  IntegrationRun,
  SisyphusDatabase,
  Workflow,
} from '@bluetel-ai/sisyphus-api/db'
import {
  executionProfiles,
  executionProfileVersions,
  integrationMappings,
  integrationRuns,
  integrations,
  ticketClaims,
  users,
  workflowEvents,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, asc, count, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'

/**
 * Every read and write the integration tick makes, in one place (T117).
 *
 * Split out of `integration-tick.ts` so the tick reads as the six-step algorithm
 * `contracts/integration-connector.md` specifies rather than as a hundred lines of Drizzle. The
 * division is the one `admin/profile-store.ts` uses in `sisyphus-api`: this module knows the
 * schema and nothing about the algorithm; the tick knows the algorithm and no column names.
 *
 * Nothing here names a board (FR-192).
 */

/** Satisfied by the pooled handle or by an open transaction. */
export type IntegrationReader = Pick<SisyphusDatabase, 'select'>
export type IntegrationWriter = Pick<SisyphusDatabase, 'insert' | 'select' | 'update'>

/** See `admit-workflow.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

export const findIntegration = async (
  reader: IntegrationReader,
  integrationId: string,
): Promise<Integration | undefined> =>
  firstRow(await reader.select().from(integrations).where(eq(integrations.id, integrationId)))

/** Every integration, ordered by id, so a sweep is deterministic (FR-100, FR-104). */
export const listIntegrations = async (
  reader: IntegrationReader,
): Promise<readonly Integration[]> =>
  reader.select().from(integrations).orderBy(asc(integrations.id))

/**
 * The mappings, in the {@link ContractMapping} shape and in `position` order.
 *
 * Ordered here rather than trusted to the connector: first-match is the configuration (FR-130), and
 * a connector that sorted them itself would be a connector the ordering depended on.
 */
export const listMappings = async (
  reader: IntegrationReader,
  integrationId: string,
): Promise<readonly ContractMapping[]> => {
  const rows = await reader
    .select({
      id: integrationMappings.id,
      position: integrationMappings.position,
      criteria: integrationMappings.criteria,
      executionProfileId: integrationMappings.executionProfileId,
      isDefault: integrationMappings.isDefault,
    })
    .from(integrationMappings)
    .where(eq(integrationMappings.integrationId, integrationId))
    .orderBy(asc(integrationMappings.position))

  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    criteria: (row.criteria ?? {}) as Readonly<Record<string, unknown>>,
    executionProfileId: row.executionProfileId,
    isDefault: row.isDefault,
  }))
}

/** What a resolved profile contributes to a run (FR-096). The integration contributes none of it. */
export interface ProfileLaunch {
  readonly executionProfileId: string
  readonly executionProfileVersionId: string
  readonly enabled: boolean
  readonly workspaceVersionId: string
  readonly setupBundleVersionId: string
  readonly model: Workflow['model']
  readonly instanceType: string
  readonly purchaseMode: Workflow['purchaseMode']
  readonly turnCap: number | null
  readonly spendCap: string | null
  readonly defaultWorkflowType: Workflow['type']
  /** The topmost prompt layer (FR-157). */
  readonly promptPreamble: string | null
}

/**
 * The launch values behind an execution profile's **current** version.
 *
 * Reads the version rather than the profile, because the version is what a workflow records and
 * what reconstructs its configuration afterwards (FR-065, FR-126).
 */
export const readProfileLaunch = async (
  reader: IntegrationReader,
  executionProfileId: string,
): Promise<ProfileLaunch | undefined> =>
  firstRow(
    await reader
      .select({
        executionProfileId: executionProfiles.id,
        executionProfileVersionId: executionProfileVersions.id,
        enabled: executionProfiles.enabled,
        workspaceVersionId: executionProfileVersions.workspaceVersionId,
        setupBundleVersionId: executionProfileVersions.setupBundleVersionId,
        model: executionProfileVersions.model,
        instanceType: executionProfileVersions.instanceType,
        purchaseMode: executionProfileVersions.purchaseMode,
        turnCap: executionProfileVersions.turnCap,
        spendCap: executionProfileVersions.spendCap,
        defaultWorkflowType: executionProfileVersions.defaultWorkflowType,
        promptPreamble: executionProfileVersions.promptPreamble,
      })
      .from(executionProfiles)
      .innerJoin(
        executionProfileVersions,
        eq(executionProfileVersions.id, executionProfiles.currentVersionId),
      )
      .where(eq(executionProfiles.id, executionProfileId)),
  )

/**
 * A tick that has been opened and not closed (FR-103).
 *
 * The open row *is* the "a previous tick is still running" signal. There is no in-memory flag,
 * because the control plane is a set of scheduled invocations rather than a process: a flag would
 * be lost on the restart that most needs it.
 */
export const findOpenRun = async (
  reader: IntegrationReader,
  integrationId: string,
): Promise<IntegrationRun | undefined> =>
  firstRow(
    await reader
      .select()
      .from(integrationRuns)
      .where(and(eq(integrationRuns.integrationId, integrationId), isNull(integrationRuns.endedAt)))
      .orderBy(asc(integrationRuns.startedAt))
      .limit(1),
  )

/**
 * Open a run record.
 *
 * Written **before** discovery, not after, so a tick that dies mid-flight leaves a row saying it
 * started — which is what makes the next tick able to see it (FR-103) and what makes a
 * silently-failing connector visible at all (FR-105).
 */
export const openRun = async (
  writer: IntegrationWriter,
  input: { readonly integrationId: string; readonly trigger: IntegrationRun['trigger'] },
): Promise<IntegrationRun> => {
  const row = firstRow(
    await writer
      .insert(integrationRuns)
      .values({ integrationId: input.integrationId, trigger: input.trigger })
      .returning(),
  )

  if (row === undefined) {
    throw new Error('Opening an integration run returned no row.')
  }

  return row
}

/** Why one candidate was not started. Closed vocabulary, so runs can be counted by it (FR-105). */
export interface RecordedSkip {
  readonly externalId: string
  readonly reason: string
  /** Never the item's title or body — a run record is not a place for ticket content (FR-072). */
  readonly detail?: string
}

export interface RunTotals {
  readonly examinedCount: number
  readonly matchedCount: number
  readonly startedCount: number
  readonly skipReasons: readonly RecordedSkip[]
  /** Present when the tick failed; drives consecutive-failure tracking (FR-106, FR-108). */
  readonly error?: string
}

/** Close a run with what it did. `skippedCount` is derived, so the two cannot disagree. */
export const closeRun = async (
  writer: IntegrationWriter,
  runId: string,
  totals: RunTotals,
): Promise<void> => {
  await writer
    .update(integrationRuns)
    .set({
      endedAt: new Date(),
      examinedCount: totals.examinedCount,
      matchedCount: totals.matchedCount,
      startedCount: totals.startedCount,
      skippedCount: totals.skipReasons.length,
      skipReasons: totals.skipReasons,
      error: totals.error ?? null,
    })
    .where(eq(integrationRuns.id, runId))
}

/**
 * How many workflows this integration has started since a moment (FR-107).
 *
 * Counted against `workflows`, not against `integration_runs.started_count`, because the rolling
 * ceiling is about runs that exist and cost money — a run record whose tick was killed before it
 * closed would otherwise take its started count with it.
 */
export const countStartedSince = async (
  reader: IntegrationReader,
  integrationId: string,
  since: Date,
): Promise<number> => {
  const rows = await reader
    .select({ value: count() })
    .from(workflows)
    .where(
      and(eq(workflows.originatingIntegrationId, integrationId), gte(workflows.createdAt, since)),
    )

  return firstRow(rows)?.value ?? 0
}

/**
 * Resolve the owner: the assignee where the platform knows them, otherwise the integration's
 * default owner (FR-132, FR-133).
 *
 * Ownership does not require profile access (FR-191) — an assignee may own a run on a profile they
 * do not hold — so this is a lookup by identity and deliberately not a grant check.
 */
export const resolveOwnerUserId = async (
  reader: IntegrationReader,
  input: {
    readonly assigneeEmail: string | null
    readonly defaultOwnerUserId: string | null
  },
): Promise<string | undefined> => {
  const email = input.assigneeEmail?.trim().toLowerCase()

  if (email !== undefined && email.length > 0) {
    const matched = firstRow(
      await reader
        .select({ id: users.id })
        .from(users)
        .where(and(eq(sql`lower(${users.email})`, email), eq(users.isActive, true))),
    )

    if (matched !== undefined) {
      return matched.id
    }
  }

  return input.defaultOwnerUserId ?? undefined
}

/**
 * A claim on the same ticket held by a **different integration pointing at the same board**
 * (FR-104).
 *
 * The scope is the subtle part. `ticket_claims` is unique on `(integration_id, external_id)`, which
 * is right: `FIX-1` on one client's board and `FIX-1` on another's are different tickets, and a
 * globally unique external id would put the second board's ticket permanently out of reach. So the
 * cross-integration guard is scoped to integrations sharing a `base_url` and `project_prefix` —
 * two rows genuinely pointing at the same board, which is the misconfiguration FR-104 is about.
 *
 * What the guard guarantees is that **exactly one workflow starts**. The deterministic
 * lowest-`integrations.id` winner holds when the ticks are ordered; where a higher-id integration
 * claimed first, the claim stands — the run it began cannot be recalled — and the collision is recorded on the
 * lower-id integration's run, which is what puts the misconfiguration in front of an admin.
 */
export const findCompetingClaim = async (
  reader: IntegrationReader,
  input: {
    readonly integrationId: string
    readonly externalId: string
    readonly baseUrl: string
    readonly projectPrefix: string
  },
): Promise<{ readonly integrationId: string; readonly workflowId: string | null } | undefined> => {
  const siblings = await reader
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.baseUrl, input.baseUrl),
        eq(integrations.projectPrefix, input.projectPrefix),
        ne(integrations.id, input.integrationId),
      ),
    )

  if (siblings.length === 0) {
    return undefined
  }

  return firstRow(
    await reader
      .select({ integrationId: ticketClaims.integrationId, workflowId: ticketClaims.workflowId })
      .from(ticketClaims)
      .where(
        and(
          eq(ticketClaims.externalId, input.externalId),
          inArray(
            ticketClaims.integrationId,
            siblings.map((sibling) => sibling.id),
          ),
        ),
      )
      .orderBy(asc(ticketClaims.integrationId))
      .limit(1),
  )
}

/** Everything a started run needs that does not come from the ticket. */
export interface ClaimAndStartInput {
  readonly integrationId: string
  readonly externalId: string
  readonly mappingId: string
  readonly ownerUserId: string
  readonly ticketUrl: string
  readonly assembledPrompt: string
  readonly promptTruncated: boolean
  readonly profile: ProfileLaunch
}

/** The claim was ours; the workflow exists. */
export interface ClaimedAndStarted {
  readonly outcome: 'started'
  readonly workflowId: string
  readonly claimId: string
}

/** Somebody already holds this ticket — an overlapping tick, or this tick's own retry (FR-102). */
export interface AlreadyClaimed {
  readonly outcome: 'already_claimed'
  readonly workflowId: string | null
}

export type ClaimOutcome = AlreadyClaimed | ClaimedAndStarted

/**
 * **The claim and the workflow, in one transaction** (FR-102, step 4d).
 *
 * The unique index on `(integration_id, external_id)` — not the code below — is what makes
 * exactly-once hold. `onConflictDoNothing` returns no row when the index refuses the insert, and
 * that is the whole mechanism: an overlapping tick, a retried invocation and a process that died
 * between claiming and inserting the workflow all reach the same place, because there is no moment
 * at which a claim exists without its run.
 *
 * Ordered claim-then-workflow rather than the reverse deliberately. A workflow inserted first would
 * be a paid run already in the queue when the claim is refused, and rolling it back is a race the
 * queue drain could have won.
 */
export const claimAndStart = async (
  db: SisyphusDatabase,
  input: ClaimAndStartInput,
): Promise<ClaimOutcome> =>
  db.transaction(async (tx) => {
    const claim = firstRow(
      await tx
        .insert(ticketClaims)
        .values({ integrationId: input.integrationId, externalId: input.externalId })
        .onConflictDoNothing({ target: [ticketClaims.integrationId, ticketClaims.externalId] })
        .returning({ id: ticketClaims.id }),
    )

    if (claim === undefined) {
      const existing = firstRow(
        await tx
          .select({ workflowId: ticketClaims.workflowId })
          .from(ticketClaims)
          .where(
            and(
              eq(ticketClaims.integrationId, input.integrationId),
              eq(ticketClaims.externalId, input.externalId),
            ),
          ),
      )

      return { outcome: 'already_claimed', workflowId: existing?.workflowId ?? null }
    }

    const workflow = firstRow(
      await tx
        .insert(workflows)
        .values({
          type: input.profile.defaultWorkflowType,
          state: 'queued',
          // Null: an integration-started run was not initiated by a person (FR-132).
          initiatedByUserId: null,
          originatingIntegrationId: input.integrationId,
          originatingMappingId: input.mappingId,
          ownerUserId: input.ownerUserId,
          executionProfileId: input.profile.executionProfileId,
          executionProfileVersionId: input.profile.executionProfileVersionId,
          setupBundleVersionId: input.profile.setupBundleVersionId,
          workspaceVersionId: input.profile.workspaceVersionId,
          ticketReference: input.ticketUrl,
          assembledPrompt: input.assembledPrompt,
          promptTruncated: input.promptTruncated,
          model: input.profile.model,
          instanceType: input.profile.instanceType,
          purchaseMode: input.profile.purchaseMode,
          turnCap: input.profile.turnCap,
          spendCap: input.profile.spendCap,
          sessionId: randomUUID(),
        })
        .returning({ id: workflows.id }),
    )

    if (workflow === undefined) {
      throw new Error(
        'Inserting the workflow for a claimed ticket returned no row, so the claim would outlive the run it was taken for.',
      )
    }

    await tx
      .update(ticketClaims)
      .set({ workflowId: workflow.id })
      .where(eq(ticketClaims.id, claim.id))

    await tx.insert(workflowEvents).values({
      workflowId: workflow.id,
      event: 'created',
      actorType: 'integration',
      detail: {
        integrationId: input.integrationId,
        mappingId: input.mappingId,
        externalId: input.externalId,
        promptTruncated: input.promptTruncated,
      },
    })

    return { outcome: 'started', workflowId: workflow.id, claimId: claim.id }
  })

/** The most recent closed run, for `since` and for the health tracker. */
export const findLastCompletedRun = async (
  reader: IntegrationReader,
  integrationId: string,
): Promise<IntegrationRun | undefined> =>
  firstRow(
    await reader
      .select()
      .from(integrationRuns)
      .where(eq(integrationRuns.integrationId, integrationId))
      .orderBy(desc(integrationRuns.startedAt))
      .limit(1),
  )
