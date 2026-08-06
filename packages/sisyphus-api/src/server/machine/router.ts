import type { Artifact, BootstrapPhase } from '../../db'
import {
  appendLogSegmentInput,
  heartbeatInput,
  registerArtifactInput,
  registerSnapshotInput,
  reportBootstrapPhaseInput,
  reportEntryResultInput,
  reportReviewerSummaryInput,
  reportTerminalInput,
} from '../../schemas'
import { createTRPCRouter, machineProcedure } from '../procedures'
import {
  acknowledgeCorrectionProcedure,
  pullPendingCorrectionsProcedure,
} from '../workflow/corrections'
import { acknowledgeCommandProcedure, pullPendingCommandsProcedure } from '../workflow/supervision'

import { registerArtifact } from './artifacts'
import type { RenewedCredential } from './credential'
import { renewCredential } from './credential'
import type { EntryCheckoutReport } from './entries'
import { reportEntryCheckout, reportEntryCheckoutInput } from './entries'
import type { EntryResultReport } from './entry-results'
import { reportEntryResult } from './entry-results'
import type { MachineContext } from './guard'
import { reportIterationProcedure } from './iterations'
import type { AppendedLogSegment } from './log-segments'
import { appendLogSegment } from './log-segments'
import type { HeartbeatAcknowledgement, TerminalReport } from './reporting'
import { heartbeat, reportBootstrapPhase, reportTerminal } from './reporting'
import type { ReviewerSummaryReport } from './reviewer-summary'
import { reportReviewerSummary } from './reviewer-summary'
import type { RegisteredSnapshot } from './snapshot'
import { registerSnapshot } from './snapshot'

/**
 * The machine surface — everything an executor instance reports back (FR-018, FR-037, FR-046,
 * FR-047, FR-048, FR-056, FR-145).
 *
 * ## This router's inputs and outputs *are* the wire contract
 *
 * `apps/sisyphus-executor` imports the router's **type** and nothing else — no resolver code and
 * no database driver is bundled onto the instance, which is what stops a compromised setup bundle
 * from reaching the database (FR-005, FR-006). The consequence is that every shape below is a
 * published interface: each returns a plain object of dates, numbers, strings and booleans, all of
 * which survive `superjson`, and none returns a Drizzle query builder, a class instance or an
 * error object. Changing one of these shapes is a protocol change.
 *
 * ## Two properties every procedure here holds
 *
 * 1. **Every write is scoped to `ctx.workflowId`.** No input schema carries a workflow id, so
 *    there is nothing to compare and nothing to get wrong on most of them; where a payload *can*
 *    reach outside its run — the `entryId` on `reportBootstrapPhase` and `registerArtifact`, and
 *    the credential row behind `renewCredential` — it is resolved and checked against the
 *    credential, and a mismatch is refused **and recorded** as a `cross_workflow_write` security
 *    event (FR-018, SC-014). See `./guard.ts`.
 * 2. **Calling twice is safe.** The executor retries with backoff whenever this surface is
 *    unreachable and cannot tell a lost response from a failed write (FR-047).
 *    `appendLogSegment` is idempotent on `(workflowId, sequence)` by unique index;
 *    `reportBootstrapPhase` updates rather than duplicates; `reportTerminal` keeps the first
 *    outcome; `heartbeat` moves consumption under `greatest`.
 *
 * An executor credential grants nothing on the interactive surface, and this router is mounted
 * separately from `appRouter` rather than as a branch of it — so the interactive procedures are
 * not reachable from the machine mount at all (FR-005).
 */

/** Narrow the tRPC context to what the resolvers actually need. */
const machineContext = (ctx: {
  readonly db: MachineContext['db']
  readonly workflowId: MachineContext['workflowId']
  readonly credential: MachineContext['credential']
  readonly dependencies: MachineContext['dependencies']
}): MachineContext => ({
  db: ctx.db,
  workflowId: ctx.workflowId,
  credential: ctx.credential,
  dependencies: ctx.dependencies,
})

export const machineSurfaceRouter = createTRPCRouter({
  /** Liveness plus consumption, so a lapsed heartbeat and an exhausted cap look different (FR-048). */
  heartbeat: machineProcedure
    .input(heartbeatInput)
    .mutation(
      async ({ ctx, input }): Promise<HeartbeatAcknowledgement> =>
        heartbeat(machineContext(ctx), input),
    ),

  /** Attributable bootstrap progress, so a timeout names the phase that hung (FR-145, FR-146). */
  reportBootstrapPhase: machineProcedure
    .input(reportBootstrapPhaseInput)
    .mutation(
      async ({ ctx, input }): Promise<BootstrapPhase> =>
        reportBootstrapPhase(machineContext(ctx), input),
    ),

  /** One chunk of run output, recorded at most once per `(workflow, sequence)` (FR-046, FR-047). */
  appendLogSegment: machineProcedure
    .input(appendLogSegmentInput)
    .mutation(
      async ({ ctx, input }): Promise<AppendedLogSegment> =>
        appendLogSegment(machineContext(ctx), input),
    ),

  /** The last thing an executor says (FR-056, FR-064). */
  reportTerminal: machineProcedure
    .input(reportTerminalInput)
    .mutation(
      async ({ ctx, input }): Promise<TerminalReport> => reportTerminal(machineContext(ctx), input),
    ),

  /** Extend the caller's own short-lived, workflow-scoped credential (FR-037). */
  renewCredential: machineProcedure.mutation(
    async ({ ctx }): Promise<RenewedCredential> => renewCredential(machineContext(ctx)),
  ),

  /** What the run produced, so it stays findable after the instance is gone (FR-014, SC-012). */
  registerArtifact: machineProcedure
    .input(registerArtifactInput)
    .mutation(
      async ({ ctx, input }): Promise<Artifact> => registerArtifact(machineContext(ctx), input),
    ),

  /**
   * One repository's outcome, so a partial multi-repo result stays expressible (FR-114, FR-115,
   * FR-118). The `entryId` is the one payload field that can name a row outside this credential's
   * run, and it is checked and recorded — see `./entry-results.ts`.
   */
  reportEntryResult: machineProcedure
    .input(reportEntryResultInput)
    .mutation(
      async ({ ctx, input }): Promise<EntryResultReport> =>
        reportEntryResult(machineContext(ctx), input),
    ),

  /**
   * One repository's resolved commit, **at checkout time** (FR-114).
   *
   * Called by bootstrap phase 6 as each entry lands, before the agent starts, so a run that dies in
   * its first turn still records what it was run against. First write wins, and a repeat is
   * answered successfully rather than refused — see `./entries.ts` for why FR-047 makes that the
   * only safe shape. Its `entryId` is guarded exactly as `reportEntryResult`'s is.
   */
  reportEntryCheckout: machineProcedure
    .input(reportEntryCheckoutInput)
    .mutation(
      async ({ ctx, input }): Promise<EntryCheckoutReport> =>
        reportEntryCheckout(machineContext(ctx), input),
    ),

  /**
   * The capture that makes a run resumable (FR-050, FR-053).
   *
   * The payload names no workflow, as nothing here does; what it *does* name is a `sessionId`, and
   * that is resolved against the credential's own chain of predecessors before anything is written
   * — see `./snapshot.ts`. A snapshot missing either half of FR-050 is still recorded, and still
   * refused as the workflow's resume point.
   */
  registerSnapshot: machineProcedure
    .input(registerSnapshotInput)
    .mutation(
      async ({ ctx, input }): Promise<RegisteredSnapshot> =>
        registerSnapshot(machineContext(ctx), input),
    ),

  /**
   * One pass of the autonomous develop→review loop (FR-061, FR-062).
   *
   * The `ordinal ≤ 3` bound is a check constraint on the table, not a count taken here, so a
   * fourth pass is unwritable however the caller arrives. This resolver only translates the
   * refusal: a `23514` becomes a `BAD_REQUEST` naming the constraint, so an executor that retries
   * stops rather than looping on a write that can never succeed.
   */
  reportIteration: reportIterationProcedure,

  /**
   * The collection half of supervision. The instance polls; nothing pushes to it, because it has
   * no inbound surface either. `acknowledge*` is what moves a run to `paused` — the panel showing
   * "paused" before this lands would be claiming a pause the instance has not performed.
   */
  pullPendingCommands: pullPendingCommandsProcedure,
  acknowledgeCommand: acknowledgeCommandProcedure,
  pullPendingCorrections: pullPendingCorrectionsProcedure,
  acknowledgeCorrection: acknowledgeCorrectionProcedure,

  /** What the reviewer of the resulting change needs to know (FR-153). */
  reportReviewerSummary: machineProcedure
    .input(reportReviewerSummaryInput)
    .mutation(
      async ({ ctx, input }): Promise<ReviewerSummaryReport> =>
        reportReviewerSummary(machineContext(ctx), input),
    ),
})

export type MachineSurfaceRouter = typeof machineSurfaceRouter
