import { and, asc, count, desc, eq, inArray, lt } from 'drizzle-orm'

import type { IntegrationMapping as ContractMapping } from '../../contracts'
import type {
  Integration,
  IntegrationMapping,
  IntegrationRun,
  NewIntegration,
  SisyphusDatabase,
} from '../../db'
import {
  executionProfiles,
  executionProfileVersions,
  integrationMappings,
  integrationRuns,
  integrations,
  ticketClaims,
  workflows,
} from '../../db'

import type { Page } from './user-queries'
import { paginate } from './user-queries'

/**
 * Data access for `integrations`, `integration_mappings` and `integration_runs`.
 *
 * Kept apart from the router in `integrations.ts` the way `profile-store.ts` is kept apart from
 * `profiles.ts`, and shaped by one rule above the others:
 *
 * **`credential_secret_arn` is never selected into anything a client can see.** Not because the ARN
 * is itself a secret — it is a pointer — but because "write-only from the panel" (FR-098) only
 * holds if there is no read path at all. A column that is returned "just for the admin screen"
 * becomes a column that is logged, cached in a query client, and eventually rendered. So
 * {@link integrationColumns} does not list it, and no exported function in this module returns it
 * except {@link readConnectorTarget}, which exists to hand it to a connector adapter and is not
 * reachable from a resolver's return value.
 */

/** Anything that can run the statements here — the pooled handle or an open transaction. */
export type IntegrationStoreWriter = Pick<
  SisyphusDatabase,
  'select' | 'insert' | 'update' | 'delete'
>

/** See `admit-workflow.ts` in the control plane: indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * The columns the panel may see. **`credentialSecretArn` is deliberately absent** (FR-098).
 *
 * Written out rather than `select *` minus one, so adding a column to the table is a decision to
 * expose it rather than an accident.
 */
export const integrationColumns = {
  id: integrations.id,
  type: integrations.type,
  name: integrations.name,
  baseUrl: integrations.baseUrl,
  projectPrefix: integrations.projectPrefix,
  label: integrations.label,
  extraFilters: integrations.extraFilters,
  defaultOwnerUserId: integrations.defaultOwnerUserId,
  promptIntro: integrations.promptIntro,
  cronExpression: integrations.cronExpression,
  timezone: integrations.timezone,
  perTickCeiling: integrations.perTickCeiling,
  rollingPeriodCeiling: integrations.rollingPeriodCeiling,
  rollingPeriodMinutes: integrations.rollingPeriodMinutes,
  enabled: integrations.enabled,
  consecutiveFailures: integrations.consecutiveFailures,
  autoDisabledReason: integrations.autoDisabledReason,
  scheduleArn: integrations.scheduleArn,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
} as const

/** One integration, as every read in this package returns it: without its credential reference. */
export type VisibleIntegration = Omit<Integration, 'credentialSecretArn'>

/** A mapping as the panel edits it. */
export interface VisibleMapping {
  readonly id: string
  readonly position: number
  readonly criteria: Readonly<Record<string, unknown>>
  readonly executionProfileId: string
  readonly executionProfileName: string | null
  readonly isDefault: boolean
}

export interface IntegrationListing extends VisibleIntegration {
  readonly mappings: readonly VisibleMapping[]
  /** How many tickets this integration has ever taken responsibility for (FR-102). */
  readonly claimedTicketCount: number
  /** How many runs it has started, so an admin can see what it costs. */
  readonly startedWorkflowCount: number
  readonly lastRun: IntegrationRun | undefined
}

export interface ListIntegrationsQuery {
  readonly enabledOnly: boolean
  readonly type?: Integration['type']
  readonly limit: number
  readonly cursor?: string
}

/** Mappings for a set of integrations, with the profile names an admin actually recognises. */
const readMappings = async (
  writer: IntegrationStoreWriter,
  integrationIds: readonly string[],
): Promise<Map<string, VisibleMapping[]>> => {
  const grouped = new Map<string, VisibleMapping[]>()

  if (integrationIds.length === 0) {
    return grouped
  }

  const rows = await writer
    .select({
      integrationId: integrationMappings.integrationId,
      id: integrationMappings.id,
      position: integrationMappings.position,
      criteria: integrationMappings.criteria,
      executionProfileId: integrationMappings.executionProfileId,
      executionProfileName: executionProfiles.name,
      isDefault: integrationMappings.isDefault,
    })
    .from(integrationMappings)
    .leftJoin(executionProfiles, eq(executionProfiles.id, integrationMappings.executionProfileId))
    .where(inArray(integrationMappings.integrationId, integrationIds))
    .orderBy(asc(integrationMappings.integrationId), asc(integrationMappings.position))

  for (const row of rows) {
    const list = grouped.get(row.integrationId) ?? []
    list.push({
      id: row.id,
      position: row.position,
      criteria: (row.criteria ?? {}) as Readonly<Record<string, unknown>>,
      executionProfileId: row.executionProfileId,
      executionProfileName: row.executionProfileName,
      isDefault: row.isDefault,
    })
    grouped.set(row.integrationId, list)
  }

  return grouped
}

const countClaims = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<number> => {
  const rows = await writer
    .select({ value: count() })
    .from(ticketClaims)
    .where(eq(ticketClaims.integrationId, integrationId))

  return firstRow(rows)?.value ?? 0
}

const countStartedWorkflows = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<number> => {
  const rows = await writer
    .select({ value: count() })
    .from(workflows)
    .where(eq(workflows.originatingIntegrationId, integrationId))

  return firstRow(rows)?.value ?? 0
}

/** The most recent run, so the panel can show whether the board is answering (FR-105). */
export const findLatestRun = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<IntegrationRun | undefined> =>
  firstRow(
    await writer
      .select()
      .from(integrationRuns)
      .where(eq(integrationRuns.integrationId, integrationId))
      .orderBy(desc(integrationRuns.startedAt))
      .limit(1),
  )

export const listIntegrations = async (
  writer: IntegrationStoreWriter,
  query: ListIntegrationsQuery,
): Promise<Page<IntegrationListing>> => {
  const filters = [
    query.enabledOnly ? eq(integrations.enabled, true) : undefined,
    query.type === undefined ? undefined : eq(integrations.type, query.type),
    query.cursor === undefined ? undefined : lt(integrations.id, query.cursor),
  ].filter((filter) => filter !== undefined)

  const rows = await writer
    .select(integrationColumns)
    .from(integrations)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(desc(integrations.id))
    .limit(query.limit + 1)

  const page = paginate(rows, query.limit)
  const mappings = await readMappings(
    writer,
    page.items.map((item) => item.id),
  )

  const items = await Promise.all(
    page.items.map(async (integration): Promise<IntegrationListing> => {
      const [claimedTicketCount, startedWorkflowCount, lastRun] = await Promise.all([
        countClaims(writer, integration.id),
        countStartedWorkflows(writer, integration.id),
        findLatestRun(writer, integration.id),
      ])

      return {
        ...integration,
        mappings: mappings.get(integration.id) ?? [],
        claimedTicketCount,
        startedWorkflowCount,
        lastRun,
      }
    }),
  )

  return { items, nextCursor: page.nextCursor }
}

/** One integration, without its credential reference. */
export const findIntegration = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<VisibleIntegration | undefined> =>
  firstRow(
    await writer
      .select(integrationColumns)
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1),
  )

export const findIntegrationByName = async (
  writer: IntegrationStoreWriter,
  name: string,
): Promise<VisibleIntegration | undefined> =>
  firstRow(
    await writer
      .select(integrationColumns)
      .from(integrations)
      .where(eq(integrations.name, name))
      .limit(1),
  )

/**
 * The credential reference, for handing to a connector adapter.
 *
 * The **only** function here that reads the column, and it returns nothing else that a resolver
 * would be tempted to pass through to a client. Callers hand the result straight to
 * `IntegrationConnectorRegistry.connectorFor` and never put it in a response.
 */
export const readConnectorTarget = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<
  | {
      readonly type: Integration['type']
      readonly baseUrl: string
      readonly credentialSecretArn: string
      readonly projectPrefix: string
      readonly label: string
      readonly extraFilters: unknown
      readonly promptIntro: string
    }
  | undefined
> =>
  firstRow(
    await writer
      .select({
        type: integrations.type,
        baseUrl: integrations.baseUrl,
        credentialSecretArn: integrations.credentialSecretArn,
        projectPrefix: integrations.projectPrefix,
        label: integrations.label,
        extraFilters: integrations.extraFilters,
        promptIntro: integrations.promptIntro,
      })
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1),
  )

export const insertIntegration = async (
  writer: IntegrationStoreWriter,
  values: NewIntegration,
): Promise<VisibleIntegration> => {
  const row = firstRow(
    await writer.insert(integrations).values(values).returning(integrationColumns),
  )

  if (row === undefined) {
    throw new Error('Inserting an integration returned no row.')
  }

  return row
}

export const updateIntegration = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
  values: Partial<NewIntegration>,
): Promise<VisibleIntegration | undefined> =>
  firstRow(
    await writer
      .update(integrations)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(integrations.id, integrationId))
      .returning(integrationColumns),
  )

/**
 * Replace an integration's mappings wholesale.
 *
 * Delete-then-insert rather than a diff. Mappings are evaluated first-match by `position`, so the
 * *set* is the configuration; reconciling row by row would leave a window in which a partially
 * applied ordering was live, and a tick landing in that window would resolve tickets under a rule
 * nobody wrote. The caller holds a transaction around this, so there is no such window.
 */
export const replaceMappings = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
  mappings: readonly {
    readonly position: number
    readonly criteria: Record<string, unknown>
    readonly executionProfileId: string
    readonly isDefault: boolean
  }[],
): Promise<readonly IntegrationMapping[]> => {
  await writer
    .delete(integrationMappings)
    .where(eq(integrationMappings.integrationId, integrationId))

  if (mappings.length === 0) {
    return []
  }

  return writer
    .insert(integrationMappings)
    .values(
      mappings.map((mapping) => ({
        integrationId,
        position: mapping.position,
        criteria: mapping.criteria,
        executionProfileId: mapping.executionProfileId,
        isDefault: mapping.isDefault,
      })),
    )
    .returning()
}

/** The mappings in the contract's shape, for handing to a connector's `resolveProfile`. */
export const readContractMappings = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<readonly ContractMapping[]> => {
  const rows = await writer
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

/** The prompt preamble a mapping's profile contributes (FR-157), or `null` where it carries none. */
export const readProfilePreamble = async (
  writer: IntegrationStoreWriter,
  executionProfileId: string,
): Promise<string | null | undefined> => {
  const row = firstRow(
    await writer
      .select({ promptPreamble: executionProfileVersions.promptPreamble })
      .from(executionProfiles)
      .innerJoin(
        executionProfileVersions,
        eq(executionProfileVersions.id, executionProfiles.currentVersionId),
      )
      .where(eq(executionProfiles.id, executionProfileId))
      .limit(1),
  )

  return row?.promptPreamble
}

export interface ListRunsQuery {
  readonly integrationId: string
  readonly limit: number
  readonly cursor?: string
}

/** A page of run history, newest first (FR-105). */
export const listRuns = async (
  writer: IntegrationStoreWriter,
  query: ListRunsQuery,
): Promise<Page<IntegrationRun>> => {
  const rows = await writer
    .select()
    .from(integrationRuns)
    .where(
      and(
        eq(integrationRuns.integrationId, query.integrationId),
        query.cursor === undefined ? undefined : lt(integrationRuns.id, query.cursor),
      ),
    )
    .orderBy(desc(integrationRuns.id))
    .limit(query.limit + 1)

  return paginate(rows, query.limit)
}

/** What deleting an integration would take with it, so the refusal can name it (FR-128's spirit). */
export interface IntegrationReferences {
  readonly claimedTicketCount: number
  readonly startedWorkflowCount: number
  readonly deletable: boolean
}

export const readIntegrationReferences = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<IntegrationReferences> => {
  const [claimedTicketCount, startedWorkflowCount] = await Promise.all([
    countClaims(writer, integrationId),
    countStartedWorkflows(writer, integrationId),
  ])

  return {
    claimedTicketCount,
    startedWorkflowCount,
    // A workflow records `originating_integration_id` for the whole retention period (FR-065), so
    // deleting an integration that has ever started one would make those runs unexplainable.
    // Disabling is what the panel offers instead.
    deletable: startedWorkflowCount === 0 && claimedTicketCount === 0,
  }
}

/** Remove an integration and its mappings. Only ever reached when nothing references it. */
export const deleteIntegration = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<void> => {
  await writer
    .delete(integrationMappings)
    .where(eq(integrationMappings.integrationId, integrationId))
  await writer.delete(integrationRuns).where(eq(integrationRuns.integrationId, integrationId))
  await writer.delete(integrations).where(eq(integrations.id, integrationId))
}
