import type {
  CandidateItem,
  IntegrationConnector,
  WriteBackEvent,
  WriteBackSkipReason,
} from '@bluetel-ai/sisyphus-api/contracts'
import type { Integration, IntegrationRun, SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'

import { assembleIntegrationPrompt, hasNoTask } from './assemble-prompt'
import type { ConnectorRegistry } from './connector-registry'
import { connectorFor } from './connector-registry'
import { recordRunOutcome } from './integration-health'
import type { ProfileLaunch, RecordedSkip } from './integration-store'
import {
  claimAndStart,
  closeRun,
  countStartedSince,
  findCompetingClaim,
  findIntegration,
  findOpenRun,
  listMappings,
  openRun,
  readProfileLaunch,
  resolveOwnerUserId,
} from './integration-store'
import type { PromptRedactor } from './prompt-redact'
import type { JobOutcome } from './run-job'
import { runJob, toError } from './run-job'

/**
 * The integration tick — the six steps of `contracts/integration-connector.md` (T117).
 *
 * ```
 * 1. Load enabled integration + mappings
 * 2. A previous tick still running → skip or coalesce, record it            FR-103
 * 3. connector.discover(config, { since: lastRunAt })
 * 4. For each candidate, in order:
 *    a. resolveProfile → no match ⇒ skip + writeBack('skipped')             FR-130, FR-143
 *    b. ceiling reached ⇒ skip + writeBack('skipped'); defer                FR-107
 *    c. empty title AND body ⇒ skip + writeBack('skipped')                  FR-164
 *    d. INSERT claim + INSERT workflow in one transaction                   FR-102
 *    e. assemble the prompt and store it as sent                            FR-159, FR-162
 *    f. writeBack('picked_up')                                              FR-142
 * 5. Record the run: examined / matched / started / skipped + reasons       FR-105
 * 6. On failure: increment consecutive failures; auto-disable past threshold FR-106, FR-108
 * ```
 *
 * ## The one place the algorithm departs from the sketch, and why
 *
 * Step (e) is written **before** step (d) here. The claim and the workflow go in one transaction
 * (FR-102), and the workflow row carries `assembled_prompt` — so the prompt has to exist before the
 * transaction opens, or the transaction would have to be held open across redaction. Assembling
 * first costs nothing when the claim is then refused: no run was started, and no comment is posted,
 * which is exactly what the sketch's (d) requires of a lost claim.
 *
 * ## Why a lost claim posts no comment
 *
 * A ticket that loses the claim was already claimed, which means the first claim already commented
 * on it (FR-142/FR-143). Commenting again would put a second identical comment from an automated
 * system on a customer's ticket every time two ticks overlapped — which is the failure `writeBack`'s
 * idempotency exists to prevent, arrived at from the other direction.
 *
 * ## What a failing write-back does not do
 *
 * It does not fail the tick, and the run it would have announced still stands. The workflow is
 * committed; a comment that could not be posted is recorded as a skip reason and retried by the next tick's
 * `writeBack`, which looks before it creates. Rolling back a paid run because a comment failed
 * would be the wrong trade in the obvious direction.
 */

export const INTEGRATION_TICK_JOB_NAME = 'integration-tick'

/** How the tick reaches everything outside the database. Each one is a port, none is a board. */
export interface IntegrationTickDependencies {
  readonly db: SisyphusDatabase
  /** Where a connector comes from — the FR-192 seam. See `connector-registry.ts`. */
  readonly connectors: ConnectorRegistry
  /**
   * Reads the board credential from the secret store, at tick time, never cached to disk (FR-072).
   *
   * A port rather than a Secrets Manager client, so this suite makes no AWS call.
   */
  readonly readCredential: (secretArn: string) => Promise<string>
  /**
   * The run-output redaction standard (FR-163). See `prompt-redact.ts` for why the control plane
   * takes one rather than implementing one.
   */
  readonly redactor: PromptRedactor
  /** Injectable so a test states the clock rather than racing it. */
  readonly now?: () => Date
}

export interface IntegrationTickOptions extends IntegrationTickDependencies {
  readonly integrationId: string
  /** `manual` is an admin pressing Run now (FR-097); `scheduled` is the timer. */
  readonly trigger?: IntegrationRun['trigger']
}

/** The tick did not run, and why. Never an error: none of these is a failure. */
export interface TickNotRun {
  readonly outcome: 'not_run'
  readonly reason: 'unknown_integration' | 'disabled' | 'previous_tick_running'
  readonly integrationId: string
  /** The run that is still open, for the coalesced case (FR-103). */
  readonly openRunId?: string
}

export interface TickCompleted {
  readonly outcome: 'completed'
  readonly integrationId: string
  readonly runId: string
  readonly examined: number
  readonly matched: number
  readonly started: number
  readonly startedWorkflowIds: readonly string[]
  readonly skips: readonly RecordedSkip[]
}

/** Discovery threw, or the tick could not be assembled. Recorded, then retried (FR-105, FR-108). */
export interface TickFailed {
  readonly outcome: 'failed'
  readonly integrationId: string
  readonly runId: string
  readonly error: string
  /** True when this failure crossed the auto-disable threshold (FR-106). */
  readonly autoDisabled: boolean
  readonly consecutiveFailures: number
}

export type TickOutcome = TickCompleted | TickFailed | TickNotRun

/**
 * The connector's configuration, assembled from the row.
 *
 * Deliberately *not* the row: `credential_secret_arn`, the cron expression, the ceilings and the
 * schedule are the control plane's and no connector's (FR-096). The shape is what every connector
 * type needs to reach a board — where it is, what to look at, what marks an item — and the
 * connector parses it into its own schema, failing the tick if it cannot (FR-105).
 */
export const connectorConfigFor = (integration: Integration): Record<string, unknown> => ({
  baseUrl: integration.baseUrl,
  projectPrefix: integration.projectPrefix,
  label: integration.label,
  extraFilters: integration.extraFilters ?? undefined,
})

/** State carried through one tick's candidate loop. */
interface TickLedger {
  matched: number
  started: number
  readonly startedWorkflowIds: string[]
  readonly skips: RecordedSkip[]
}

/**
 * Comment on an item, and never let that failure lose the tick.
 *
 * A board that accepts a workflow's creation and refuses its comment has produced a run that
 * exists; treating the comment as the transaction boundary would throw the run away.
 */
const sayOnItem = async (
  connector: IntegrationConnector<unknown>,
  config: unknown,
  item: CandidateItem,
  event: WriteBackEvent,
  ledger: TickLedger,
): Promise<void> => {
  try {
    await connector.writeBack(config, item, event)
  } catch (thrown) {
    ledger.skips.push({
      externalId: item.externalId,
      reason: 'write_back_failed',
      detail: `${event.kind}: ${toError(thrown).message}`,
    })
  }
}

/** Skip an item, record why, and say so on the item (FR-143). A labelled item is never ignored. */
const skipItem = async (
  connector: IntegrationConnector<unknown>,
  config: unknown,
  item: CandidateItem,
  skip: { readonly reason: WriteBackSkipReason; readonly detail?: string },
  ledger: TickLedger,
): Promise<void> => {
  ledger.skips.push({
    externalId: item.externalId,
    reason: skip.reason,
    ...(skip.detail === undefined ? {} : { detail: skip.detail }),
  })

  await sayOnItem(
    connector,
    config,
    item,
    {
      kind: 'skipped',
      ...(skip.detail === undefined ? {} : { detail: skip.detail }),
      reason: skip.reason,
    },
    ledger,
  )
}

/** Step 4, for one candidate. Returns nothing: everything it decided is on the ledger. */
const considerItem = async (options: {
  readonly item: CandidateItem
  readonly integration: Integration
  readonly connector: IntegrationConnector<unknown>
  readonly config: unknown
  readonly mappings: Awaited<ReturnType<typeof listMappings>>
  readonly dependencies: IntegrationTickDependencies
  readonly perTickRemaining: () => number
  readonly rollingRemaining: () => number
  readonly ledger: TickLedger
}): Promise<void> => {
  const { config, connector, dependencies, integration, item, ledger } = options

  // (a) Resolve the profile. No match is a recorded skip, never a guessed profile (FR-130).
  const resolution = connector.resolveProfile(item, options.mappings)

  if (!resolution.matched) {
    await skipItem(
      connector,
      config,
      item,
      { reason: 'no_mapping_matched', detail: resolution.reason },
      ledger,
    )
    return
  }

  ledger.matched += 1

  // (b) Ceilings. Deferred, not dropped: an unclaimed ticket still matches on the next tick.
  if (options.perTickRemaining() <= 0 || options.rollingRemaining() <= 0) {
    await skipItem(
      connector,
      config,
      item,
      {
        reason: 'ceiling_reached',
        detail:
          options.perTickRemaining() <= 0
            ? 'the per-tick ceiling is reached; this item is deferred to a later tick'
            : 'the rolling-period ceiling is reached; this item is deferred to a later tick',
      },
      ledger,
    )
    return
  }

  // (c) Nothing to ask for (FR-164).
  if (hasNoTask(item)) {
    await skipItem(
      connector,
      config,
      item,
      { reason: 'empty_item', detail: 'the ticket has neither a title nor a description' },
      ledger,
    )
    return
  }

  const profile: ProfileLaunch | undefined = await readProfileLaunch(
    dependencies.db,
    resolution.executionProfileId,
  )

  if (profile?.enabled !== true) {
    await skipItem(
      connector,
      config,
      item,
      {
        reason: 'no_mapping_matched',
        detail:
          profile === undefined
            ? 'the mapped execution profile has no published version'
            : 'the mapped execution profile is disabled',
      },
      ledger,
    )
    return
  }

  const ownerUserId = await resolveOwnerUserId(dependencies.db, {
    assigneeEmail: item.assigneeEmail,
    defaultOwnerUserId: integration.defaultOwnerUserId,
  })

  if (ownerUserId === undefined) {
    // FR-133: an integration cannot be enabled without a default owner, so this is a row that was
    // edited out from under an enabled integration. No run without an accountable human (FR-132).
    await skipItem(
      connector,
      config,
      item,
      {
        reason: 'integration_disabled',
        detail: 'the integration has no default owner to attribute this run to',
      },
      ledger,
    )
    return
  }

  // FR-104: another integration on the same board already holds this ticket.
  const competing = await findCompetingClaim(dependencies.db, {
    integrationId: integration.id,
    externalId: item.externalId,
    baseUrl: integration.baseUrl,
    projectPrefix: integration.projectPrefix,
  })

  if (competing !== undefined) {
    ledger.skips.push({
      externalId: item.externalId,
      reason: 'claimed_by_another_integration',
      detail: `integration ${competing.integrationId} already holds this ticket`,
    })
    return
  }

  // (e) The prompt, before the row it is recorded on (FR-159, FR-162, FR-163).
  const assembled = assembleIntegrationPrompt({
    preamble: profile.promptPreamble,
    intro: integration.promptIntro,
    parts: connector.assemblePromptParts(item, {}),
    redactor: dependencies.redactor,
  })

  // (d) Claim and workflow, one transaction. The unique index is the guarantee (FR-102).
  const claimed = await claimAndStart(dependencies.db, {
    integrationId: integration.id,
    externalId: item.externalId,
    mappingId: resolution.mappingId,
    ownerUserId,
    ticketUrl: item.url,
    assembledPrompt: assembled.prompt,
    promptTruncated: assembled.truncated,
    profile,
  })

  if (claimed.outcome === 'already_claimed') {
    // No comment: the first claim already made one. See the note at the top of this file.
    ledger.skips.push({
      externalId: item.externalId,
      reason: 'already_claimed',
      ...(claimed.workflowId === null ? {} : { detail: `workflow ${claimed.workflowId}` }),
    })
    return
  }

  ledger.started += 1
  ledger.startedWorkflowIds.push(claimed.workflowId)

  // (f) Say so on the ticket (FR-142).
  await sayOnItem(
    connector,
    config,
    item,
    {
      kind: 'picked_up',
      workflowId: claimed.workflowId,
      workflowUrl: `${integration.baseUrl.replace(/\/$/, '')}/sisyphus/workflows/${claimed.workflowId}`,
    },
    ledger,
  )
}

/**
 * Run one tick.
 *
 * @param options - The integration to tick and everything outside the database it needs.
 * @returns Which of the three things happened. Never throws for a board failure: an unreachable
 *   system is a recorded failed run, which is what FR-108 asks for.
 */
export const integrationTick = async (options: IntegrationTickOptions): Promise<TickOutcome> => {
  const { connectors, db, integrationId } = options
  const now = options.now ?? (() => new Date())
  const trigger = options.trigger ?? 'scheduled'

  // 1. Load the integration and its mappings.
  const integration = await findIntegration(db, integrationId)

  if (integration === undefined) {
    return { outcome: 'not_run', reason: 'unknown_integration', integrationId }
  }

  if (!integration.enabled) {
    return { outcome: 'not_run', reason: 'disabled', integrationId }
  }

  // 2. A previous tick is still running (FR-103). Coalesced: this tick is dropped, not queued.
  const open = await findOpenRun(db, integrationId)

  if (open !== undefined) {
    return {
      outcome: 'not_run',
      reason: 'previous_tick_running',
      integrationId,
      openRunId: open.id,
    }
  }

  const run = await openRun(db, { integrationId, trigger })
  const ledger: TickLedger = { matched: 0, started: 0, startedWorkflowIds: [], skips: [] }

  try {
    const credential = await options.readCredential(integration.credentialSecretArn)
    const config = connectorConfigFor(integration)
    const connector = connectorFor(connectors, {
      type: integration.type,
      config,
      credential,
      baseUrl: integration.baseUrl,
    })
    const mappings = await listMappings(db, integrationId)

    // 3. Discover. `since` is advisory — see the note on `DiscoverContext`.
    const items = await connector.discover(config, {
      recordSkip: (skip) => {
        ledger.skips.push({ externalId: skip.detail, reason: skip.reason, detail: skip.detail })
      },
    })

    const rollingSince = new Date(now().getTime() - integration.rollingPeriodMinutes * 60 * 1000)
    const alreadyStarted = await countStartedSince(db, integrationId, rollingSince)

    // 4. Each candidate, in order.
    for (const item of items) {
      await considerItem({
        item,
        integration,
        connector,
        config,
        mappings,
        dependencies: options,
        perTickRemaining: () => integration.perTickCeiling - ledger.started,
        rollingRemaining: () =>
          integration.rollingPeriodCeiling - (alreadyStarted + ledger.started),
        ledger,
      })
    }

    // 5. Record what the tick did (FR-105).
    await closeRun(db, run.id, {
      examinedCount: items.length,
      matchedCount: ledger.matched,
      startedCount: ledger.started,
      skipReasons: ledger.skips,
    })

    await recordRunOutcome(db, { integrationId, succeeded: true })

    return {
      outcome: 'completed',
      integrationId,
      runId: run.id,
      examined: items.length,
      matched: ledger.matched,
      started: ledger.started,
      startedWorkflowIds: ledger.startedWorkflowIds,
      skips: ledger.skips,
    }
  } catch (thrown) {
    // 6. A failed run is recorded and counted, never swallowed and never thrown (FR-106, FR-108).
    const error = toError(thrown)

    await closeRun(db, run.id, {
      examinedCount: 0,
      matchedCount: ledger.matched,
      startedCount: ledger.started,
      skipReasons: ledger.skips,
      error: error.message,
    })

    const health = await recordRunOutcome(db, {
      integrationId,
      succeeded: false,
      reason: error.message,
    })

    return {
      outcome: 'failed',
      integrationId,
      runId: run.id,
      error: error.message,
      autoDisabled: health.autoDisabled,
      consecutiveFailures: health.consecutiveFailures,
    }
  }
}

/** The tick wrapped in the uniform job envelope. */
export const runIntegrationTick = (
  options: IntegrationTickOptions,
): Promise<JobOutcome<TickOutcome>> =>
  runJob(INTEGRATION_TICK_JOB_NAME, () => integrationTick(options))
