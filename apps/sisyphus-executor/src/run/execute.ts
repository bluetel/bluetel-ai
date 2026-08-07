/**
 * **The run, whole (T173, T175, T176, T178, FR-046, FR-047, FR-048, FR-054, FR-056, FR-203).**
 *
 * Everything below this line already existed and was tested. What did not exist was a caller: the
 * output pipeline had no producer, the heartbeat had none, `watchForInterruption` had none, the
 * supervision poller had none, and all three workflow types were reachable only from their barrel.
 * FR-203 calls that a defect rather than a component awaiting integration, and this module is the
 * integration.
 *
 * ```
 * 1  arm reporting        segment writer, phase reporter, heartbeat        (FR-046, FR-048)
 * 2  bootstrap            phases 2–7                                       (./bootstrap.ts)
 * 3  arm supervision      command poller, interruption watch               (FR-049, FR-054)
 * 4  run the workflow     delegated | autonomous | review                  (./dispatch.ts)
 * 5  report terminal      outcome, reason, consumption; then flush         (FR-047, FR-056)
 * 6  tear down            stop the agent, run the shutdown hooks
 * ```
 *
 * ## Step 5 happens on every path out of this function
 *
 * FR-056 is the requirement that shapes the whole control flow: a run must never exit leaving its
 * recorded state as `running`. So the workflow, the bootstrap and the assembly itself are all
 * inside one `try`, every failure becomes a `failed` outcome with the reason sanitised, and the
 * terminal report and the flush are in the path that always runs. A crash between steps 2 and 4
 * reports; an envelope this executor cannot serve reports; a bundle that will not verify reports.
 * The only thing that can stop a terminal report reaching the surface is the surface being
 * unreachable, which is what the outbox and `isReportingDegraded` are for.
 *
 * ## Interruption is not a second code path, and that is the whole of FR-054
 *
 * `watchForInterruption` is armed the moment the agent is up and races the workflow. It is the
 * *only* thing in this file that knows what an interruption is, and all it does with one is call
 * the same `suspend()` a manual pause goes through — see `session/interruption.ts` for why the
 * type makes any other arrangement impossible. A notice therefore ends the run as
 * `parked_resumable` with a registered snapshot, by the same six steps a pause uses, exercised
 * every time anybody presses Pause rather than only during a reclamation.
 *
 * ## Where the acknowledgement happens, and why it is not `suspend`'s
 *
 * `suspend()` takes an optional `acknowledge` and this module does not supply one. That is not an
 * omission: the machine surface's only acknowledgement channel is `acknowledgeCommand`, and
 * `createSupervisionPoller` sends it **after** the handler resolves — which is after the snapshot
 * has been captured and registered. That is exactly FR-049's ordering, arrived at through the
 * queue that owns the command rather than through a second call this module would have to
 * sequence correctly by hand.
 *
 * ## The ports this assembly does not have
 *
 * {@link WorkflowPortsFactory} is where the agent-facing ports come from — the developer, the
 * reviewer, the forge for each entry. They are a factory rather than fields because they are
 * built *from* the checked-out workspace, which does not exist until step 2. A factory that
 * returns nothing for the job's workflow type produces an FR-203 halt from `dispatchWorkflow`,
 * naming the type, which then reports terminal `failed` like any other refusal — rather than a
 * process that exits silently having done nothing.
 */

import type { AgentAdapter, AgentFrame, AgentUsage } from '../agent'
import type { BootstrapPhaseReporter, BundleArchiveStore } from '../bootstrap'
import type { CapEnforcer } from '../caps'
import { createCapEnforcer } from '../caps'
import type { WorkflowJobEnvelope } from '../job-envelope'
import { capLimitsFrom } from '../job-envelope'
import type { KnownSecret, SanitisedText, SegmentStore, SegmentWriter } from '../output'
import { createSegmentWriter, sanitise } from '../output'
import type { MachineSurfaceClient } from '../report'
import type { ShutdownRegistry } from '../runtime'
import type {
  InstanceMetadataReader,
  InterruptionWatchResult,
  ParkBudget,
  SnapshotPort,
  SuspendOptions,
  SuspendResult,
} from '../session'
import {
  createPauseIdleCeiling,
  createQuietMetadataReader,
  pauseIdleCeilingReason,
  suspend,
  watchForInterruption,
} from '../session'
import type { SupervisionPoller, SupervisionTransport } from '../supervision'
import { createSupervisionPoller } from '../supervision'

import type { BootstrappedRun } from './bootstrap'
import { bootstrapRun } from './bootstrap'
import type {
  AutonomousPorts,
  DelegatedPorts,
  ReviewPorts,
  WorkflowDispatchResult,
} from './dispatch'
import { dispatchWorkflow } from './dispatch'
import type { HeartbeatLoop, HeartbeatState } from './heartbeat'
import { createHeartbeatLoop } from './heartbeat'
import type { RunExternalActionLedgers } from './ledgers'
import { createRunExternalActionLedgers } from './ledgers'
import { createParkReporter } from './park-report'

/** Which of the three port bundles this assembly can supply for this run. */
export interface WorkflowPortSelection {
  readonly delegated?: DelegatedPorts
  readonly autonomous?: AutonomousPorts
  readonly review?: ReviewPorts
}

/** What a port factory is given: everything that exists once the agent is up. */
export interface WorkflowPortsContext {
  readonly envelope: WorkflowJobEnvelope
  readonly bootstrapped: BootstrappedRun
  readonly client: MachineSurfaceClient
  readonly caps: CapEnforcer
  readonly secrets: readonly KnownSecret[]
  /**
   * The run's external-action ledgers, already backed by the durable claim (FR-076, FR-077).
   *
   * Supplied rather than left to the factory because the difference between a durable ledger and
   * a `new Map()` is invisible at the call site and the consequence of getting it wrong is a
   * second comment on a customer's ticket. A factory that builds its own is choosing per-process
   * deduplication; see `./ledgers.ts`.
   */
  readonly ledgers: RunExternalActionLedgers
}

export type WorkflowPortsFactory = (
  context: WorkflowPortsContext,
) => Promise<WorkflowPortSelection> | WorkflowPortSelection

export interface RunExecutorOptions {
  readonly envelope: WorkflowJobEnvelope
  readonly client: MachineSurfaceClient
  readonly archives: BundleArchiveStore
  readonly segments: SegmentStore
  /** The snapshot writer `suspend()` captures through (FR-050). */
  readonly snapshots: SnapshotPort
  readonly adapter: AgentAdapter
  readonly ports: WorkflowPortsFactory
  /** `SISYPHUS_BUNDLES_BUCKET`. Instance configuration, never the envelope's. */
  readonly bundlesBucket: string
  /** `SISYPHUS_WORKSPACE_ROOT` — the pinned root (FR-051, R2). */
  readonly workspaceRoot: string
  /**
   * Whether the credential the bundle installs meters per-workflow spend.
   *
   * Defaults to `false`, which makes a declared spend cap **advisory** and surfaces a notice
   * saying so. That default is deliberate and is the safe direction: claiming a cap is enforced
   * when the credential cannot meter it would be a promise the platform cannot keep.
   */
  readonly spendCapsEnforceable?: boolean
  /** Credentials the setup bundle installed, so every sanitiser knows them (FR-072). */
  readonly secrets?: readonly KnownSecret[]
  /** Defaults to a reader that never reports a notice; see `session/interruption.ts`. */
  readonly metadata?: InstanceMetadataReader
  /** Hooks registered here run once, in reverse order, whatever ends the run. */
  readonly shutdown?: ShutdownRegistry
  readonly heartbeatIntervalMs?: number
  readonly interruptionPollMs?: number
  readonly supervisionIntervalMs?: number
  /**
   * How long a snapshot boundary may park before the run gives up on it (FR-082).
   *
   * Defaults to `DEFAULT_PARK_BUDGET` — eight attempts over roughly two minutes; see
   * `session/park.ts` for why that number is what it is. Exposed for the same reason the three
   * intervals above are: a test that had to wait out the real budget to observe a park would not
   * be written.
   */
  readonly parkBudget?: ParkBudget
  /**
   * How long a pause may sit untouched before this instance hands itself back (FR-049, US2 §4).
   *
   * Defaults to `PAUSE_IDLE_CEILING_MS`; see `session/idle-ceiling.ts` for why the executor holds
   * this clock and why the reconciler holds a later copy of it.
   */
  readonly pauseIdleCeilingMs?: number
  /** Reported and never fatal: reporting problems must not end a run that is working. */
  readonly onReportingFailure?: (error: unknown, detail: string) => void
}

export interface ExecutorRunResult {
  /** Exactly one of FR-064's closed set, and what was reported (FR-056). */
  readonly outcome: WorkflowDispatchResult['outcome']
  readonly reason: SanitisedText
  readonly usage: AgentUsage
  readonly workflow?: WorkflowDispatchResult
  /** Present when the run ended by suspending rather than by finishing. */
  readonly suspension?: SuspendResult
  readonly heartbeats: number
  /** Latched if the report buffer ever filled — the run's record is incomplete (FR-047). */
  readonly reportingDegraded: boolean
}

/** The display text of one frame, or nothing for a frame that carries none. */
export const frameText = (frame: AgentFrame): string | undefined => {
  if (frame.type === 'assistant' || frame.type === 'user') {
    return frame.text
  }

  return frame.type === 'unknown' ? frame.raw : undefined
}

const describe = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

/**
 * A bootstrap phase reporter that reaches the machine surface.
 *
 * `phaseStarted` has no procedure to call — the surface's `reportBootstrapPhase` takes an outcome
 * and has no room for "this one has begun" — so a start goes into the log stream instead, which is
 * what the panel is already reading and is therefore where FR-145's "no phase of unknown duration"
 * actually becomes visible.
 */
export const createSurfacePhaseReporter = (options: {
  readonly client: Pick<MachineSurfaceClient, 'reportBootstrapPhase'>
  readonly log: (line: string) => Promise<void>
  readonly onFailure?: (error: unknown, detail: string) => void
}): BootstrapPhaseReporter => ({
  phaseStarted: async (event) => {
    await options.log(
      `[bootstrap] ${event.phase}${event.entryId === undefined ? '' : ` (${event.entryId})`} ` +
        `started; it has ${String(event.timeoutMs)}ms of its own\n`,
    )
  },
  phaseFinished: async (event) => {
    await options.log(
      `[bootstrap] ${event.phase} ${event.outcome} after ${String(event.durationMs)}ms` +
        `${event.detail === undefined ? '' : `: ${event.detail}`}\n`,
    )

    try {
      await options.client.reportBootstrapPhase({
        phase: event.phase,
        ...(event.entryId === undefined ? {} : { entryId: event.entryId }),
        outcome: event.outcome,
        ...(event.detail === undefined ? {} : { detail: sanitise(event.detail) }),
      })
    } catch (error) {
      options.onFailure?.(error, `reporting bootstrap phase ${event.phase}`)
    }
  },
})

/** The machine surface, in the shape the supervision poller takes. */
export const supervisionTransportFor = (
  client: Pick<MachineSurfaceClient, 'pullPendingCommands' | 'acknowledgeCommand'>,
): SupervisionTransport => ({
  pullPendingCommands: async () => client.pullPendingCommands(),
  acknowledgeCommand: async (acknowledgement) => {
    await client.acknowledgeCommand({
      commandId: acknowledgement.commandId,
      outcome: acknowledgement.outcome,
      ...(acknowledgement.failureReason === undefined
        ? {}
        : { failureReason: acknowledgement.failureReason }),
    })
  },
})

interface RunningState {
  state: HeartbeatState
  suspension?: SuspendResult
}

/**
 * Run one job, end to end.
 *
 * @param options - The envelope, the machine surface, the object stores, the agent adapter and
 *   the factory that supplies the workflow's own ports.
 * @returns The outcome that was reported, with the consumption it was reported alongside.
 */
export const runExecutor = async (options: RunExecutorOptions): Promise<ExecutorRunResult> => {
  const { client, envelope, workspaceRoot } = options
  const secrets = options.secrets ?? []
  const running: RunningState = { state: 'provisioning' }

  const caps = createCapEnforcer({
    spendCapsEnforceable: options.spendCapsEnforceable ?? false,
    ...capLimitsFrom(envelope.job),
  })

  const usageOf = (): AgentUsage => options.adapter.usage

  // ---- 1. Reporting -------------------------------------------------------------------------

  const segmentWriter: SegmentWriter = createSegmentWriter({
    workflowId: envelope.workflowId,
    store: options.segments,
    reporter: client,
    ...(secrets.length === 0 ? {} : { secrets }),
  })

  const log = async (line: string): Promise<void> => {
    try {
      await segmentWriter.write(line)
    } catch (error) {
      options.onReportingFailure?.(error, 'writing a log segment')
    }
  }

  const heartbeat: HeartbeatLoop = createHeartbeatLoop({
    client,
    state: () => running.state,
    usage: usageOf,
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { intervalMs: options.heartbeatIntervalMs }),
    ...(options.onReportingFailure === undefined
      ? {}
      : {
          onFailure: (error, consecutive) => {
            options.onReportingFailure?.(error, `heartbeat (${String(consecutive)} in a row)`)
          },
        }),
  })

  const beating = heartbeat.run()

  const reporter = createSurfacePhaseReporter({
    client,
    log,
    ...(options.onReportingFailure === undefined ? {} : { onFailure: options.onReportingFailure }),
  })

  // Armed before the try, cancelled in the finally: an instance that hands itself back has to do
  // so whichever way the run ends, and a live timer must not outlive the process that owns it.
  const pauseIdle = createPauseIdleCeiling(
    options.pauseIdleCeilingMs === undefined ? {} : { ceilingMs: options.pauseIdleCeilingMs },
  )

  let bootstrapped: BootstrappedRun | undefined
  let poller: SupervisionPoller | undefined
  let polling: Promise<void> | undefined
  let watching: Promise<InterruptionWatchResult> | undefined
  const watchController = new AbortController()
  let pumping: Promise<void> | undefined
  let workflow: WorkflowDispatchResult | undefined
  let outcome: WorkflowDispatchResult['outcome'] = 'failed'
  let reason = 'the run ended without recording a reason, which is itself the defect (FR-056)'

  try {
    // ---- 2. Bootstrap -----------------------------------------------------------------------

    bootstrapped = await bootstrapRun({
      envelope,
      archives: options.archives,
      bundlesBucket: options.bundlesBucket,
      workspaceRoot,
      reporter,
      adapter: options.adapter,
      ...(secrets.length === 0 ? {} : { secrets }),
      onSetupOutput: (text) => {
        void log(text)
      },
    })

    running.state = 'running'

    // The agent's frames become the run's log. Started here rather than at construction because
    // `output` is a single-consumer stream and there is nothing on it until the agent is up.
    const started = bootstrapped

    pumping = (async () => {
      for await (const frame of started.agent.adapter.output) {
        const text = frameText(frame)

        if (text !== undefined && text !== '') {
          await log(`${text}\n`)
        }
      }
    })()

    // ---- 3. Supervision ---------------------------------------------------------------------

    const suspension: Omit<SuspendOptions, 'reason'> = {
      agent: started.agent.adapter,
      snapshot: options.snapshots,
      sessionId: envelope.sessionId,
      workspaceRoot,
      ...(options.parkBudget === undefined ? {} : { parkBudget: options.parkBudget }),
      registerSnapshot: async (registration) => {
        await client.registerSnapshot({
          sessionId: registration.sessionId,
          s3Key: registration.s3Key,
          sizeBytes: registration.sizeBytes,
          boundary: registration.boundary,
          hasConversationState: registration.hasConversationState,
          hasWorktreeState: registration.hasWorktreeState,
          truncationRepaired: false,
        })
      },
      // Not a log line. A park is a fact about the run — the snapshot could not be written, the
      // agent is holding at the boundary it reached, and the write is being retried — and until
      // T184 the only consumer of `onParked` wrote text nothing could query, so the panel showed a
      // two-minute park as an ordinary `running` run. See `./park-report.ts` (FR-082).
      onParked: createParkReporter({
        client,
        log,
        ...(secrets.length === 0 ? {} : { secrets }),
        ...(options.onReportingFailure === undefined
          ? {}
          : { onReportingFailure: options.onReportingFailure }),
      }),
    }

    poller = createSupervisionPoller({
      transport: supervisionTransportFor(client),
      handlers: {
        onPause: async () => {
          const paused = await suspend({ ...suspension, reason: 'pause' })
          running.suspension = paused
          running.state = 'paused'
          // The pause plan says `on-idle-ceiling` and this is the thing that eventually acts on
          // it. Started from the suspension's own timestamp, not from here (FR-049, US2 §4).
          pauseIdle.begin(paused.suspendedAt)
        },
        onStop: async () => {
          pauseIdle.cancel()
          running.suspension = await suspend({ ...suspension, reason: 'stop' })
          running.state = 'cancelled'
        },
        // `resume` is ordinarily the control plane provisioning a fresh instance rather than
        // anything this process does — but the machine surface moves the run back to `running` on
        // an acknowledged resume, so an instance that is still here must stop counting down
        // towards handing itself back. Without this, a resumed run would park mid-work.
        onResume: async () => {
          pauseIdle.cancel()
          running.state = 'running'

          await Promise.resolve()
        },
      },
      ...(options.supervisionIntervalMs === undefined
        ? {}
        : { intervalMs: options.supervisionIntervalMs }),
      onCycleError: (error) => {
        options.onReportingFailure?.(error, 'polling the supervision queue')
      },
    })

    polling = poller.run()

    watching = watchForInterruption({
      metadata: options.metadata ?? createQuietMetadataReader(),
      suspension,
      signal: watchController.signal,
      ...(options.interruptionPollMs === undefined
        ? {}
        : { pollIntervalMs: options.interruptionPollMs }),
      onNotice: (notice) => {
        running.state = 'parked_resumable'
        void log(
          `[interruption] this instance is being reclaimed at ${notice.reclaimAt.toISOString()}; ` +
            'suspending through the same path a pause takes (FR-054)\n',
        )
      },
      onReadFailure: (error, consecutive) => {
        options.onReportingFailure?.(
          error,
          `reading instance metadata (${String(consecutive)} in a row)`,
        )
      },
    })

    // ---- 4. The workflow, racing the reclamation notice --------------------------------------

    const selection = await options.ports({
      envelope,
      bootstrapped: started,
      client,
      caps,
      secrets,
      // Built from the client, so every delivery step this run makes claims its action through
      // `external_actions` before performing it rather than trusting a map this process owns.
      ledgers: createRunExternalActionLedgers(client),
    })

    // Three things can end a run and all three are here. The workflow finishing is the ordinary
    // one; a reclamation notice and a pause left past its ceiling are the two that end it from
    // outside. Both of the latter land on `parked_resumable` with a registered snapshot, which is
    // what makes each of them a pause the platform took rather than a failure (FR-054, US2 §4).
    const finished = await Promise.race([
      dispatchWorkflow({
        workflowType: envelope.job.workflowType,
        workflowId: envelope.workflowId,
        source: started.source,
        // The `SkillReferenceReporter` every workflow threads down to `resolveSkill`. It discarded
        // its reports until `machine.reportSkillReference` was mounted, which is why
        // `workflow.skillReferences` could only ever answer empty (FR-058, FR-059, SC-016).
        report: async (skillReference) => client.reportSkillReference(skillReference),
        caps,
        usage: usageOf,
        ...(secrets.length === 0 ? {} : { secrets }),
        ...selection,
      }).then((result) => ({ kind: 'workflow' as const, result })),
      watching.then((result) => ({ kind: 'interruption' as const, result })),
      pauseIdle.expired.then((result) => ({ kind: 'pause-idle' as const, result })),
    ])

    if (finished.kind === 'workflow') {
      workflow = finished.result
      outcome = finished.result.outcome
      reason = finished.result.reason
    } else if (finished.kind === 'interruption') {
      running.suspension = finished.result.suspension ?? undefined
      outcome = 'parked_resumable'
      reason =
        'this instance was reclaimed mid-run; the conversation and the working tree were ' +
        'snapshotted and registered, so the workflow can be resumed on a fresh instance ' +
        '(FR-050, FR-054).'
    } else {
      // The pause outlived its ceiling. No second snapshot is taken — see
      // `session/idle-ceiling.ts`; the agent has been quiesced since the pause and the tree it
      // captured is still the tree. Reporting `parked_resumable` is what releases the compute:
      // the run becomes terminal, and the lease is released against a terminal workflow.
      outcome = 'parked_resumable'
      reason = pauseIdleCeilingReason(finished.result)
      await log(`[pause] ${reason}\n`)
    }
  } catch (thrown) {
    outcome = 'failed'
    reason = describe(thrown)
  } finally {
    // ---- 6a. Stop listening. Before the terminal report, so nothing applies a command against a
    //          run that has already reported its outcome.
    watchController.abort()
    poller?.stop()
    pauseIdle.cancel()

    await polling?.catch((error: unknown) => {
      options.onReportingFailure?.(error, 'the supervision loop')
    })
    await watching?.catch((error: unknown) => {
      options.onReportingFailure?.(error, 'the interruption watch')
    })
  }

  // ---- 5. Terminal report, on every path out ------------------------------------------------

  running.state = outcome
  const usage = usageOf()
  const sanitisedReason = sanitise(reason, secrets.length === 0 ? {} : { secrets })

  try {
    await segmentWriter.flush()
  } catch (error) {
    options.onReportingFailure?.(error, 'flushing the log')
  }

  try {
    await client.reportTerminal({
      outcome,
      reason: sanitisedReason,
      turnsUsed: usage.turns,
      spendUsed: usage.spendUsd.toFixed(4),
    })
  } catch (error) {
    options.onReportingFailure?.(error, 'reporting the terminal outcome')
  }

  // FR-047: everything buffered is delivered before the process ends, not on a best effort after.
  try {
    await client.flush()
  } catch (error) {
    options.onReportingFailure?.(error, 'flushing buffered reports')
  }

  // ---- 6b. Tear down ------------------------------------------------------------------------

  await heartbeat.stop()
  await beating.catch(() => undefined)

  // A suspension that stopped the agent already did this; `stop` is documented as safe to call
  // twice, so there is no branch here to get wrong.
  await options.adapter.stop({ force: false }).catch((error: unknown) => {
    options.onReportingFailure?.(error, 'stopping the agent')
  })
  await pumping?.catch(() => undefined)

  if (options.shutdown !== undefined) {
    const shutdown = await options.shutdown.shutdown({ source: `run:${outcome}` })

    for (const error of shutdown.errors) {
      options.onReportingFailure?.(error, 'a shutdown hook')
    }
  }

  return {
    outcome,
    reason: sanitisedReason,
    usage,
    ...(workflow === undefined ? {} : { workflow }),
    ...(running.suspension === undefined ? {} : { suspension: running.suspension }),
    heartbeats: heartbeat.beats,
    reportingDegraded: client.isReportingDegraded,
  }
}
