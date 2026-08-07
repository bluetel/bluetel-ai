import type { RouterOutputs } from '@bluetel-ai/sisyphus-api/client'

import type { IntegrationRunView, IntegrationView } from './integrations-client'

/**
 * The router's listing, narrowed to what the screen renders (T199, FR-098, FR-105).
 *
 * ## Why a mapping rather than passing the row through
 *
 * `admin.integrations.list` returns rows straight off the table, so it carries two things the
 * screen has no use for — `createdAt`/`updatedAt` — and one it cannot type: `extra_filters` is
 * `jsonb`, which reaches the client as `unknown`. {@link toIntegrationView} is where that becomes
 * `Record<string, unknown> | null`, once, rather than at each of the four places the editor reads
 * it.
 *
 * ## The credential cannot arrive here, and this file is where that is checked
 *
 * `integration-store.ts` never selects `credential_secret_arn` (FR-098), so the ARN is absent from
 * {@link IntegrationListingOutput} by construction. {@link NO_CREDENTIAL_IN_LISTING} turns that
 * into a **compile-time** assertion rather than a comment: if the column is ever added to
 * `integrationColumns`, this module stops building. A runtime redaction here would be the weaker
 * guarantee — it would mean the value had already crossed the wire.
 */

/** One integration exactly as `admin.integrations.list` returns it. */
export type IntegrationListingOutput =
  RouterOutputs['admin']['integrations']['list']['items'][number]

/**
 * Fails to compile if the listing ever grows a credential field.
 *
 * `never` is the only inhabited type here when the key is absent, so the annotation is satisfied
 * only while the router keeps its promise.
 */
export type NO_CREDENTIAL_IN_LISTING =
  Extract<
    keyof IntegrationListingOutput,
    'credentialSecretArn' | 'credential' | 'credentialArn'
  > extends never
    ? true
    : never

/** Holds the assertion above in the emitted module, so `tsc` must evaluate it. */
export const LISTING_CARRIES_NO_CREDENTIAL: NO_CREDENTIAL_IN_LISTING = true

type LastRunOutput = NonNullable<IntegrationListingOutput['lastRun']>

/**
 * The last tick, without the fields the row carries for the control plane.
 *
 * `skipReasons` is dropped deliberately: it names ticket ids and their skip reasons, which is
 * per-item board content the summary counts already stand in for (FR-105).
 */
const toRunView = (run: LastRunOutput): IntegrationRunView => ({
  id: run.id,
  trigger: run.trigger,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  examinedCount: run.examinedCount,
  matchedCount: run.matchedCount,
  startedCount: run.startedCount,
  skippedCount: run.skippedCount,
  error: run.error,
})

/**
 * `jsonb` as an object, or nothing.
 *
 * A scalar or an array in that column is not a filter set the editor can render, so it reads as
 * "no extra filters" rather than being coerced into a shape it does not have.
 */
export const toExtraFilters = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null

export const toIntegrationView = (listing: IntegrationListingOutput): IntegrationView => ({
  id: listing.id,
  type: listing.type,
  name: listing.name,
  baseUrl: listing.baseUrl,
  projectPrefix: listing.projectPrefix,
  label: listing.label,
  extraFilters: toExtraFilters(listing.extraFilters),
  defaultOwnerUserId: listing.defaultOwnerUserId,
  promptIntro: listing.promptIntro,
  cronExpression: listing.cronExpression,
  timezone: listing.timezone,
  perTickCeiling: listing.perTickCeiling,
  rollingPeriodCeiling: listing.rollingPeriodCeiling,
  rollingPeriodMinutes: listing.rollingPeriodMinutes,
  enabled: listing.enabled,
  consecutiveFailures: listing.consecutiveFailures,
  autoDisabledReason: listing.autoDisabledReason,
  scheduleArn: listing.scheduleArn,
  mappings: listing.mappings.map((mapping) => ({
    id: mapping.id,
    position: mapping.position,
    criteria: mapping.criteria,
    executionProfileId: mapping.executionProfileId,
    executionProfileName: mapping.executionProfileName,
    isDefault: mapping.isDefault,
  })),
  claimedTicketCount: listing.claimedTicketCount,
  startedWorkflowCount: listing.startedWorkflowCount,
  lastRun: listing.lastRun === undefined ? undefined : toRunView(listing.lastRun),
})
