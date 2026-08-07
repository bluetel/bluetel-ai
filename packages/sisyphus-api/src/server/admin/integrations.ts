import { TRPCError } from '@trpc/server'
import { sql } from 'drizzle-orm'

import type { CandidateItem, ValidationResult } from '../../contracts'
import type { IntegrationRun } from '../../db'
import {
  createIntegrationInput,
  integrationIdInput,
  listIntegrationRunsInput,
  listIntegrationsInput,
  previewIntegrationPromptInput,
  runIntegrationNowInput,
  setIntegrationEnabledInput,
  updateIntegrationInput,
  validateIntegrationInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import type {
  AssembledPromptPreview,
  IntegrationConnectorRegistry,
  PromptLayering,
} from './integration-connectors'
import {
  CONNECTOR_NOT_CONFIGURED_REASON,
  createRefusingConnectorRegistry,
  createRefusingPromptLayering,
} from './integration-connectors'
import type {
  IntegrationListing,
  IntegrationReferences,
  IntegrationStoreWriter,
  VisibleIntegration,
} from './integration-store'
import {
  deleteIntegration,
  findIntegration,
  findIntegrationByName,
  insertIntegration,
  listIntegrations,
  listRuns,
  readConnectorTarget,
  readContractMappings,
  readIntegrationReferences,
  readProfilePreamble,
  replaceMappings,
  updateIntegration,
} from './integration-store'
import type { Page } from './user-queries'

/**
 * `admin.integrations` — the boards the platform polls (FR-096..FR-108, FR-130, FR-158, FR-160,
 * FR-186).
 *
 * Every procedure is `adminProcedure`, without exception. An integration spends money unattended on
 * behalf of everyone (FR-186), so there is no read here an engineer is offered — not even the list.
 *
 * ## The credential is write-only, and that is a property of the read path
 *
 * FR-098 says an integration's credential is write-only from the panel. That is not implemented by
 * hiding a field: `integration-store.ts` does not select `credential_secret_arn` into anything a
 * resolver returns, so **there is no read path to forget to guard**. The consequence an admin sees
 * is that editing an integration means re-stating which secret it uses; that is the intended cost.
 * A field the panel could pre-fill is a field the value can be read back out of, and a credential
 * you can read back out of a panel is a credential you have to rotate.
 *
 * ## `setEnabled(true)` is a gate, like `profiles.setEnabled(true)`
 *
 * Three things must hold before an integration may be enabled, and each has a requirement behind
 * it: a default owner (FR-133 — otherwise a run has nobody accountable for it), a non-empty prompt
 * intro (FR-158 — otherwise a run nobody described), and at least one mapping (FR-130 — otherwise
 * every ticket it finds is skipped and the integration is a scheduled no-op). The connectivity
 * check is `validate`, run separately so an admin can diagnose without toggling state.
 *
 * ## What this router does **not** do
 *
 * It does not tick, and it does not register schedules. The control plane owns both (FR-099), and
 * the panel has no permission to provision (FR-035). `runNow` therefore *asks*: it issues a
 * Postgres `NOTIFY`, which is the same edge `plan.md` describes for admission — a database signal
 * the control plane listens on, not an endpoint the panel calls.
 */

/**
 * The one refusal for an integration, profile or user this router cannot act on.
 *
 * `NOT_FOUND` rather than `FORBIDDEN`, and singular across the three, for the reason
 * `profileTargetNotFoundError` is: a refusal that distinguished them would answer "does this id
 * exist?" for ids the caller has not been shown (FR-190).
 */
export const integrationTargetNotFoundError = (): TRPCError =>
  new TRPCError({
    code: 'NOT_FOUND',
    message: 'No such integration, execution profile or user.',
  })

/** The name is the caller's own input, so echoing it discloses nothing. */
export const duplicateIntegrationNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `An integration named ${name} already exists.`,
  })

/**
 * The integration exists and cannot be acted on in its current state.
 *
 * `CONFLICT` because the request is well-formed and the caller is entitled to make it. Safe to name
 * the state: every caller here is an admin, who may already see every integration (FR-183).
 */
export const integrationStateError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** The channel the control plane listens on for a manual tick (FR-035, FR-097). */
export const MANUAL_TICK_CHANNEL = 'sisyphus_integration_tick'

/** What `runNow` answers with. A request, deliberately, not a result. */
export interface ManualTickRequested {
  readonly integrationId: string
  readonly requested: true
  readonly channel: string
}

export interface IntegrationValidation extends ValidationResult {
  readonly integrationId: string
}

/** What `previewPrompt` answers with (FR-160). */
export interface IntegrationPromptPreview extends AssembledPromptPreview {
  readonly integrationId: string
  readonly externalId: string
  /** Which mapping the sample ticket resolved to, or why it resolved to none (FR-130). */
  readonly resolvedProfileId: string | undefined
  readonly resolutionReason: string | undefined
}

/**
 * Why the sample ticket could not be read.
 *
 * `NOT_FOUND` covers both "the board has no such ticket" and "the ticket exists but does not match
 * the integration's filters", and that is not vagueness: a preview that distinguished them would
 * be a ticket-existence oracle for any board the platform holds a credential for.
 */
const sampleTicketNotFoundError = (): TRPCError =>
  new TRPCError({
    code: 'NOT_FOUND',
    message: 'That ticket is not among the items this integration currently matches.',
  })

const connectorUnavailableError = (): TRPCError =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: CONNECTOR_NOT_CONFIGURED_REASON })

/** The connector configuration, assembled from the row. Never carries the credential (FR-072). */
const connectorConfig = (target: {
  readonly baseUrl: string
  readonly projectPrefix: string
  readonly label: string
  readonly extraFilters: unknown
}): Record<string, unknown> => ({
  baseUrl: target.baseUrl,
  projectPrefix: target.projectPrefix,
  label: target.label,
  extraFilters: target.extraFilters ?? undefined,
})

/** Detail written to the trail. Names configuration; carries no secret (FR-178). */
const auditDetail = (integration: VisibleIntegration): Record<string, unknown> => ({
  name: integration.name,
  type: integration.type,
  baseUrl: integration.baseUrl,
  projectPrefix: integration.projectPrefix,
  label: integration.label,
  cronExpression: integration.cronExpression,
  timezone: integration.timezone,
  perTickCeiling: integration.perTickCeiling,
  rollingPeriodCeiling: integration.rollingPeriodCeiling,
  rollingPeriodMinutes: integration.rollingPeriodMinutes,
  defaultOwnerUserId: integration.defaultOwnerUserId,
})

/** The three things FR-133, FR-158 and FR-130 each require before an integration may be enabled. */
export const enableRefusals = (
  integration: VisibleIntegration,
  mappingCount: number,
): readonly string[] => {
  const refusals: string[] = []

  if (integration.defaultOwnerUserId === null) {
    refusals.push(
      'it has no default owner, so a run it started would have nobody accountable for it (FR-133)',
    )
  }

  if (integration.promptIntro.trim().length === 0) {
    refusals.push(
      'its prompt intro is empty, so a run it started would be one nobody described (FR-158)',
    )
  }

  if (mappingCount === 0) {
    refusals.push(
      'it has no mappings, so every ticket it found would be skipped rather than started (FR-130)',
    )
  }

  return refusals
}

export interface IntegrationsRouterOptions {
  /**
   * Where a connector comes from. Supplied rather than imported, so `sisyphus-api` never depends on
   * an implementation of the contract it owns (FR-192).
   */
  readonly connectors: IntegrationConnectorRegistry
  /** The control plane's prompt assembler, so a preview is the prompt (FR-160, FR-162, FR-163). */
  readonly promptLayering: PromptLayering
}

/**
 * Build `admin.integrations` over one connector registry and one prompt assembler.
 *
 * @param options - See {@link IntegrationsRouterOptions}.
 */
export const createIntegrationsRouter = (options: IntegrationsRouterOptions) =>
  createTRPCRouter({
    /** Every integration, with its mappings and what it has done (FR-097, FR-105). */
    list: adminProcedure.input(listIntegrationsInput).query(
      async ({ ctx, input }): Promise<Page<IntegrationListing>> =>
        listIntegrations(ctx.db, {
          enabledOnly: input.enabledOnly,
          ...(input.type === undefined ? {} : { type: input.type }),
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
    ),

    /**
     * Register a board (FR-096, FR-186).
     *
     * Created **disabled**, always. Enabling runs the gate above, and an integration that arrived
     * enabled would be a scheduled spender that skipped the one check standing between a
     * configuration and a fleet of unattended runs.
     */
    create: adminProcedure.input(createIntegrationInput).mutation(
      async ({ ctx, input }): Promise<IntegrationListing> =>
        ctx.db.transaction(async (tx) => {
          if ((await findIntegrationByName(tx, input.name)) !== undefined) {
            throw duplicateIntegrationNameError(input.name)
          }

          const created = await insertIntegration(tx, {
            type: input.type,
            name: input.name,
            baseUrl: input.baseUrl,
            credentialSecretArn: input.credentialSecretArn,
            projectPrefix: input.projectPrefix,
            label: input.label,
            extraFilters: input.extraFilters ?? null,
            defaultOwnerUserId: input.defaultOwnerUserId ?? null,
            promptIntro: input.promptIntro,
            cronExpression: input.cronExpression,
            timezone: input.timezone,
            perTickCeiling: input.perTickCeiling,
            rollingPeriodCeiling: input.rollingPeriodCeiling,
            rollingPeriodMinutes: input.rollingPeriodMinutes,
            enabled: false,
          })

          await replaceMappings(tx, created.id, input.mappings)

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'integration',
            entityId: created.id,
            action: 'registered',
            detail: { ...auditDetail(created), mappingCount: input.mappings.length },
          })

          return readListingWithin(tx, created.id)
        }),
    ),

    /**
     * Edit a board.
     *
     * The credential reference is written on every edit, because the input carries it on every edit
     * — see the note at the top of this file. Editing does **not** disable the integration: an
     * admin fixing a cron expression on a working board should not have to re-enable it, and the
     * values that could break it (owner, intro, mappings) are the ones the enable gate covers, so
     * they are re-checked here too rather than left until the next toggle.
     */
    update: adminProcedure.input(updateIntegrationInput).mutation(
      async ({ ctx, input }): Promise<IntegrationListing> =>
        ctx.db.transaction(async (tx) => {
          const existing = await findIntegration(tx, input.integrationId)
          if (existing === undefined) {
            throw integrationTargetNotFoundError()
          }

          if (
            input.name !== existing.name &&
            (await findIntegrationByName(tx, input.name)) !== undefined
          ) {
            throw duplicateIntegrationNameError(input.name)
          }

          const updated = await updateIntegration(tx, input.integrationId, {
            name: input.name,
            baseUrl: input.baseUrl,
            credentialSecretArn: input.credentialSecretArn,
            projectPrefix: input.projectPrefix,
            label: input.label,
            extraFilters: input.extraFilters ?? null,
            defaultOwnerUserId: input.defaultOwnerUserId ?? null,
            promptIntro: input.promptIntro,
            cronExpression: input.cronExpression,
            timezone: input.timezone,
            perTickCeiling: input.perTickCeiling,
            rollingPeriodCeiling: input.rollingPeriodCeiling,
            rollingPeriodMinutes: input.rollingPeriodMinutes,
          })

          if (updated === undefined) {
            throw integrationTargetNotFoundError()
          }

          await replaceMappings(tx, updated.id, input.mappings)

          const refusals = enableRefusals(updated, input.mappings.length)
          if (updated.enabled && refusals.length > 0) {
            throw integrationStateError(
              `That change would leave an enabled integration unable to run: ${refusals.join('; ')}.`,
            )
          }

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'integration',
            entityId: updated.id,
            action: 'updated',
            detail: { ...auditDetail(updated), mappingCount: input.mappings.length },
          })

          return readListingWithin(tx, updated.id)
        }),
    ),

    /**
     * Enable or disable a board (FR-097, FR-186).
     *
     * Enabling **clears `auto_disabled_reason`**: an admin turning an auto-disabled integration back
     * on is saying the fault is fixed, and leaving the sentence behind would have the panel
     * explaining a fault that is over. The consecutive-failure count is cleared with it, so the
     * threshold is measured from the moment a human said it was ready rather than from before.
     *
     * Disabling is never gated. It is the thing an admin reaches for when a board is misbehaving.
     */
    setEnabled: adminProcedure.input(setIntegrationEnabledInput).mutation(
      async ({ ctx, input }): Promise<IntegrationListing> =>
        ctx.db.transaction(async (tx) => {
          const existing = await findIntegration(tx, input.integrationId)
          if (existing === undefined) {
            throw integrationTargetNotFoundError()
          }

          if (input.enabled) {
            const mappings = await readContractMappings(tx, existing.id)
            const refusals = enableRefusals(existing, mappings.length)

            if (refusals.length > 0) {
              throw integrationStateError(
                `That integration cannot be enabled: ${refusals.join('; ')}.`,
              )
            }
          }

          const updated = await updateIntegration(tx, existing.id, {
            enabled: input.enabled,
            ...(input.enabled ? { autoDisabledReason: null, consecutiveFailures: 0 } : {}),
          })

          if (updated === undefined) {
            throw integrationTargetNotFoundError()
          }

          if (existing.enabled !== input.enabled) {
            await recordConfigurationChange(tx, {
              actorUserId: ctx.user.id,
              entityType: 'integration',
              entityId: updated.id,
              action: input.enabled ? 'enabled' : 'disabled',
              detail: {
                name: updated.name,
                ...(input.enabled ? { clearedAutoDisableReason: existing.autoDisabledReason } : {}),
              },
            })
          }

          return readListingWithin(tx, updated.id)
        }),
    ),

    /** What would be lost if this integration went away, and whether it may be deleted. */
    references: adminProcedure
      .input(integrationIdInput)
      .query(async ({ ctx, input }): Promise<IntegrationReferences> => {
        if ((await findIntegration(ctx.db, input.integrationId)) === undefined) {
          throw integrationTargetNotFoundError()
        }
        return readIntegrationReferences(ctx.db, input.integrationId)
      }),

    /**
     * Delete a board that has never started anything (FR-186).
     *
     * An integration that *has* started a run is refused, naming why: a workflow records
     * `originating_integration_id` for the retention period (FR-065, FR-131), and deleting the row
     * it points at would make finished runs unexplainable. Disabling is offered instead — the same
     * trade FR-128 makes for profiles and workspaces.
     */
    delete: adminProcedure.input(integrationIdInput).mutation(
      async ({ ctx, input }): Promise<{ readonly deleted: true; readonly integrationId: string }> =>
        ctx.db.transaction(async (tx) => {
          const existing = await findIntegration(tx, input.integrationId)
          if (existing === undefined) {
            throw integrationTargetNotFoundError()
          }

          const references = await readIntegrationReferences(tx, existing.id)
          if (!references.deletable) {
            throw integrationStateError(
              `That integration has started ${String(references.startedWorkflowCount)} workflow(s) and claimed ${String(references.claimedTicketCount)} ticket(s); deleting it would leave those runs unexplainable. Disable it instead.`,
            )
          }

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'integration',
            entityId: existing.id,
            action: 'disabled',
            detail: { name: existing.name, deleted: true },
          })

          await deleteIntegration(tx, existing.id)

          return { deleted: true, integrationId: existing.id }
        }),
    ),

    /** The tick history — what makes a silently-failing connector visible (FR-105). */
    runs: adminProcedure
      .input(listIntegrationRunsInput)
      .query(async ({ ctx, input }): Promise<Page<IntegrationRun>> => {
        if ((await findIntegration(ctx.db, input.integrationId)) === undefined) {
          throw integrationTargetNotFoundError()
        }

        return listRuns(ctx.db, {
          integrationId: input.integrationId,
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
      }),

    /**
     * Check the configuration **and reach the board** (FR-097).
     *
     * The connector never throws for an unreachable system — it reports a failed check — so an
     * admin sees "the credential was rejected" rather than a stack trace. A deployment with no
     * connector registered is a different answer again, and says so.
     */
    validate: adminProcedure
      .input(validateIntegrationInput)
      .mutation(async ({ ctx, input }): Promise<IntegrationValidation> => {
        const target = await readConnectorTarget(ctx.db, input.integrationId)
        if (target === undefined) {
          throw integrationTargetNotFoundError()
        }

        const connector = await options.connectors.connectorFor({
          type: target.type,
          config: connectorConfig(target),
          credentialSecretArn: target.credentialSecretArn,
          baseUrl: target.baseUrl,
        })

        if (connector === undefined) {
          throw connectorUnavailableError()
        }

        const result = await connector.validate(connectorConfig(target))

        return { integrationId: input.integrationId, ok: result.ok, checks: result.checks }
      }),

    /**
     * Ask the control plane to tick this integration now (FR-097, FR-107).
     *
     * A `NOTIFY`, not a call. FR-035 gives the control plane no inbound network surface, and the
     * panel holds no permission to provision — so the edge between them is the database, exactly as
     * it is for admission. The manual tick is then subject to the same ceilings, the same claim and
     * the same run record as a scheduled one, because it *is* the same tick.
     *
     * Refused for a disabled integration: "run now" on something an admin has switched off, or that
     * auto-disabled itself after repeated failures (FR-106), would be the platform ignoring the
     * decision it was told about.
     */
    runNow: adminProcedure
      .input(runIntegrationNowInput)
      .mutation(async ({ ctx, input }): Promise<ManualTickRequested> => {
        const existing = await findIntegration(ctx.db, input.integrationId)
        if (existing === undefined) {
          throw integrationTargetNotFoundError()
        }

        if (!existing.enabled) {
          throw integrationStateError(
            existing.autoDisabledReason === null
              ? 'That integration is disabled. Enable it before running it.'
              : `That integration was ${existing.autoDisabledReason}. Enable it before running it.`,
          )
        }

        await ctx.db.execute(sql`select pg_notify(${MANUAL_TICK_CHANNEL}, ${existing.id})`)

        return { integrationId: existing.id, requested: true, channel: MANUAL_TICK_CHANNEL }
      }),

    /**
     * Render the assembled prompt for a sample ticket, before the integration is enabled (FR-160).
     *
     * The point of the preview is that an author writing a prompt intro can see which ticket fields
     * are already appended and stop restating them. So it renders the **whole** layered prompt —
     * the resolved profile's preamble, the intro, and the ticket — through the same assembler the
     * tick uses, rather than showing the intro alone.
     */
    previewPrompt: adminProcedure
      .input(previewIntegrationPromptInput)
      .query(async ({ ctx, input }): Promise<IntegrationPromptPreview> => {
        const target = await readConnectorTarget(ctx.db, input.integrationId)
        if (target === undefined) {
          throw integrationTargetNotFoundError()
        }

        const connector = await options.connectors.connectorFor({
          type: target.type,
          config: connectorConfig(target),
          credentialSecretArn: target.credentialSecretArn,
          baseUrl: target.baseUrl,
        })

        if (connector === undefined) {
          throw connectorUnavailableError()
        }

        const items = await connector.discover(connectorConfig(target), {})
        const item: CandidateItem | undefined = items.find(
          (candidate) => candidate.externalId === input.externalId,
        )

        if (item === undefined) {
          throw sampleTicketNotFoundError()
        }

        const mappings = await readContractMappings(ctx.db, input.integrationId)
        const resolution = connector.resolveProfile(item, mappings)
        const preamble = resolution.matched
          ? ((await readProfilePreamble(ctx.db, resolution.executionProfileId)) ?? null)
          : null

        const assembled = options.promptLayering.assemble({
          preamble,
          intro: target.promptIntro,
          parts: connector.assemblePromptParts(item, {}),
        })

        return {
          integrationId: input.integrationId,
          externalId: input.externalId,
          resolvedProfileId: resolution.matched ? resolution.executionProfileId : undefined,
          resolutionReason: resolution.matched ? undefined : resolution.reason,
          ...assembled,
        }
      }),
  })

/**
 * Re-read one integration as a listing, inside the transaction that just changed it.
 *
 * A mutation that returned the row it wrote would return one without its mappings and counts, and
 * the panel would then have to refetch to render what it had just saved — a round trip in which the
 * saved state and the shown state can differ.
 */
const readListingWithin = async (
  writer: IntegrationStoreWriter,
  integrationId: string,
): Promise<IntegrationListing> => {
  const page = await listIntegrations(writer, { enabledOnly: false, limit: 200 })
  const listing = page.items.find((item) => item.id === integrationId)

  if (listing === undefined) {
    throw integrationTargetNotFoundError()
  }

  return listing
}

/**
 * `admin.integrations` as it is mounted.
 *
 * Wired to the refusing connector registry and the refusing prompt assembler, which is the safe
 * default and the honest one: until a deployment supplies both, the platform genuinely cannot reach
 * a board or render a prompt to the standard the stored one is held to, and a router that answered
 * anyway would be reporting a check it had not made. Supply them through
 * {@link createIntegrationsRouter}.
 */
export const integrationsRouter = createIntegrationsRouter({
  connectors: createRefusingConnectorRegistry(),
  promptLayering: createRefusingPromptLayering(),
})

export type IntegrationsRouter = typeof integrationsRouter
