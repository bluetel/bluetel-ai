/**
 * The machine-surface client (T062, FR-005, FR-006, FR-046, FR-047, FR-048).
 *
 * ## The type-only boundary is the point
 *
 * The only thing this module takes from `@bluetel-ai/sisyphus-api` is types,
 * through the `/client` subpath, with `import type`. A type import is erased
 * at compile time, so it creates no module edge for `esbuild` to follow, and
 * the executor bundle therefore contains no resolver, no Drizzle and no
 * `postgres` driver. That is FR-005/FR-006, and it is what stops a compromised
 * setup bundle running on the instance from reaching the database: there is
 * nothing on the instance to reach it *with*, only an HTTP client pointed at a
 * surface where a workflow-scoped credential grants six procedures.
 *
 * A single value import here — even of a harmless constant from the same
 * subpath — would start pulling the API package's runtime into the bundle, and
 * the guarantee would degrade silently, because nothing would break. So it is
 * asserted rather than trusted: `boundary.test.ts` bundles this directory with
 * `esbuild` and fails if `postgres` or `drizzle` appears in the output.
 *
 * Consequently the endpoint is passed in rather than imported. It arrives on
 * the job envelope as `machineSurfaceUrl` (executor-protocol.md → Invocation),
 * which is where the executor's configuration is supposed to come from anyway.
 *
 * ## What is buffered and what is not
 *
 * FR-047 requires buffering and retry when the surface is unreachable. It does
 * not require it of *everything*, and applying it uniformly would be wrong:
 *
 * - **Buffered** — `reportBootstrapPhase`, `appendLogSegment`,
 *   `registerArtifact`, `reportTerminal`, `reportSkillReference`. Each is a
 *   durable record of something that happened, each is idempotent on the
 *   surface, and each is still true whenever it eventually lands. Losing one
 *   loses a fact.
 * - **Direct** — `heartbeat`, `renewCredential`, `registerSnapshot`,
 *   `reportSnapshotPark`, `pullPendingCommands`, `acknowledgeCommand` and
 *   `reportExternalAction`. `reportSnapshotPark` joins the heartbeat's side of
 *   the line rather than the record-keeping side: it says the run is waiting on
 *   storage *right now*, and a replayed one is a false statement about a park
 *   that has since cleared (FR-082).
 *   The last of those is direct for a reason none of the others share: it is
 *   the only call on this surface whose **response** is acted on rather than
 *   recorded, because it claims the right to post a comment before the comment
 *   is posted (FR-076). Buffering it would hand back a claim that had not been
 *   decided, which is the same as not asking. A heartbeat asserts
 *   liveness *now*; replaying a buffered one from four minutes ago is not
 *   resilience, it is a false statement about a process that may be dead, and
 *   the reconciler acts on it (FR-039, FR-048). The next heartbeat is along
 *   shortly and carries the same information, better. A credential renewal is
 *   the same shape of mistake plus a useless one: its whole value is the
 *   response, and a renewal that lands after the credential expired renews
 *   nothing.
 *
 *   The three supervision-side calls are direct for a stricter reason than
 *   staleness: `suspend()`'s call order *is* FR-049. The working tree must be
 *   captured **and registered** before the user is told the run is paused, so a
 *   `registerSnapshot` that returned as soon as it was queued would make
 *   "paused" mean "we have asked the agent to stop and we hope the snapshot
 *   works out". `acknowledgeCommand` is the same fact from the other end — it
 *   is what makes the panel's "paused" true rather than merely requested
 *   (SC-003) — and `pullPendingCommands` is a read, which there is nothing to
 *   buffer about. All of them fail loudly to their caller instead.
 *
 * The bound on the buffer, and what happens when it fills, is
 * {@link createOutbox}'s decision and is documented there.
 */

import type {
  MachineRouter,
  MachineRouterInputs,
  MachineRouterOutputs,
} from '@bluetel-ai/sisyphus-api/client'
import { createTRPCClient, httpLink } from '@trpc/client'
import superjson from 'superjson'

import type { LogSegmentRecord, SanitisedText, SegmentReporter } from '../output'

import type { Backoff, Sleeper } from './backoff'
import type { Outbox, OutboxSaturation } from './outbox'
import { createOutbox } from './outbox'

/**
 * Inputs and outputs inferred from the router rather than restated.
 *
 * Restating them would be duplication that drifts silently: nothing fails when
 * a procedure's schema changes and a hand-written copy does not. These are the
 * sanctioned way to type anything API-derived.
 */
export type HeartbeatInput = MachineRouterInputs['heartbeat']
export type BootstrapPhaseInput = MachineRouterInputs['reportBootstrapPhase']
export type AppendLogSegmentInput = MachineRouterInputs['appendLogSegment']
export type RegisterArtifactInput = MachineRouterInputs['registerArtifact']
export type TerminalInput = MachineRouterInputs['reportTerminal']
export type RegisterSnapshotInput = MachineRouterInputs['registerSnapshot']
export type AcknowledgeCommandInput = MachineRouterInputs['acknowledgeCommand']
export type SkillReferenceInput = MachineRouterInputs['reportSkillReference']
export type SnapshotParkInput = MachineRouterInputs['reportSnapshotPark']
export type ExternalActionInput = MachineRouterInputs['reportExternalAction']
export type PendingCommands = MachineRouterOutputs['pullPendingCommands']
export type RenewedCredential = MachineRouterOutputs['renewCredential']
/**
 * The claim, and the two booleans a delivery step acts on.
 *
 * Inferred rather than restated for the usual reason, but the stakes are higher here than
 * elsewhere: this is the only response on this surface a caller **branches** on, and a hand-written
 * copy that drifted would not fail to compile — it would post a second comment.
 */
export type ExternalActionClaim = MachineRouterOutputs['reportExternalAction']

/**
 * Free text that reaches the wire is `SanitisedText`, never `string`.
 *
 * `detail` and `reason` are the two fields on this surface a run can put its
 * own output into — a failed `setup.sh`, a crash message — and both are exactly
 * where a credential turns up in practice. The types below replace the
 * router's `string` with the branded type, so an unsanitised message is a
 * compile error at the call site rather than a redaction that someone
 * remembered to do (FR-045, FR-089).
 */
export type BootstrapPhaseReport = Omit<BootstrapPhaseInput, 'detail'> & {
  readonly detail?: SanitisedText
}

export type TerminalReport = Omit<TerminalInput, 'reason'> & {
  readonly reason: SanitisedText
}

/**
 * One parked snapshot attempt (FR-082).
 *
 * `detail` is the storage client's own error message, which is the third place on this surface a
 * run's environment writes free text — and object-storage failures quote the request they failed,
 * presigned query string included. So it takes the branded type like the other two.
 */
export type SnapshotParkReport = Omit<SnapshotParkInput, 'detail'> & {
  readonly detail?: SanitisedText
}

/**
 * The transport seam.
 *
 * One method per procedure on the machine router this executor calls.
 * Everything above this line is buffering policy and everything below it is
 * HTTP, which is what lets every test in this directory run against a fake and
 * never open a socket.
 */
export interface MachineSurfaceTransport {
  readonly heartbeat: (input: HeartbeatInput) => Promise<void>
  readonly reportBootstrapPhase: (input: BootstrapPhaseInput) => Promise<void>
  readonly appendLogSegment: (input: AppendLogSegmentInput) => Promise<void>
  readonly reportTerminal: (input: TerminalInput) => Promise<void>
  readonly renewCredential: () => Promise<RenewedCredential>
  readonly registerArtifact: (input: RegisterArtifactInput) => Promise<void>
  readonly registerSnapshot: (input: RegisterSnapshotInput) => Promise<void>
  readonly reportSnapshotPark: (input: SnapshotParkInput) => Promise<void>
  readonly pullPendingCommands: () => Promise<PendingCommands>
  readonly acknowledgeCommand: (input: AcknowledgeCommandInput) => Promise<void>
  readonly reportSkillReference: (input: SkillReferenceInput) => Promise<void>
  readonly reportExternalAction: (input: ExternalActionInput) => Promise<ExternalActionClaim>
}

export interface HttpMachineTransportOptions {
  /** `machineSurfaceUrl` from the job envelope — already the full mount path. */
  readonly url: string
  /**
   * The current workflow-scoped credential. A function rather than a value so
   * a renewal is picked up by the next request without rebuilding the client.
   */
  readonly credential: () => string
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The real transport.
 *
 * `httpLink`, not `httpBatchLink`. Batching couples independent records into
 * one request, so a single rejected artifact registration takes a log segment
 * down with it and the retry replays both. Volume here is low and paced by the
 * segment writer's rate limiter, so batching buys nothing worth that.
 */
export const createHttpMachineTransport = (
  options: HttpMachineTransportOptions,
): MachineSurfaceTransport => {
  const client = createTRPCClient<MachineRouter>({
    links: [
      httpLink({
        url: options.url,
        transformer: superjson,
        headers: () => ({ authorization: `Bearer ${options.credential()}` }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    ],
  })

  return {
    heartbeat: async (input) => {
      await client.heartbeat.mutate(input)
    },
    reportBootstrapPhase: async (input) => {
      await client.reportBootstrapPhase.mutate(input)
    },
    appendLogSegment: async (input) => {
      await client.appendLogSegment.mutate(input)
    },
    reportTerminal: async (input) => {
      await client.reportTerminal.mutate(input)
    },
    renewCredential: async () => client.renewCredential.mutate(),
    registerArtifact: async (input) => {
      await client.registerArtifact.mutate(input)
    },
    registerSnapshot: async (input) => {
      await client.registerSnapshot.mutate(input)
    },
    reportSnapshotPark: async (input) => {
      await client.reportSnapshotPark.mutate(input)
    },
    pullPendingCommands: async () => client.pullPendingCommands.mutate(),
    acknowledgeCommand: async (input) => {
      await client.acknowledgeCommand.mutate(input)
    },
    reportSkillReference: async (input) => {
      await client.reportSkillReference.mutate(input)
    },
    reportExternalAction: async (input) => client.reportExternalAction.mutate(input),
  }
}

export interface MachineSurfaceClientOptions {
  /**
   * The run this client reports for. Nothing on the wire carries it — the
   * credential scopes every write — but it is held here to catch a segment
   * built for another workflow before it is reported under this credential and
   * recorded as a cross-workflow write.
   */
  readonly workflowId: string
  readonly transport: MachineSurfaceTransport
  readonly maxBufferedReports?: number
  readonly backoff?: Backoff
  readonly sleep?: Sleeper
  readonly onSaturated?: (detail: OutboxSaturation) => void
}

/**
 * Extends {@link SegmentReporter} deliberately: `createSegmentWriter` already
 * defines the shape the output pipeline reports through, and this is that
 * shape rather than a second one beside it.
 */
export interface MachineSurfaceClient extends SegmentReporter {
  readonly heartbeat: (input: HeartbeatInput) => Promise<void>
  readonly renewCredential: () => Promise<RenewedCredential>
  /** Direct, because FR-049 requires it to have landed before a pause is acknowledged. */
  readonly registerSnapshot: (input: RegisterSnapshotInput) => Promise<void>
  /**
   * The other end of a snapshot boundary: the write did not go through, and the run is holding at
   * the boundary and retrying rather than advancing unsnapshotted (FR-082).
   *
   * **Direct, and for the heartbeat's reason rather than the snapshot's.** This is a claim about
   * *now* — the panel says "waiting on storage" on the strength of it — so a buffered report
   * replayed three minutes later would announce a park that had already cleared, and would be
   * timestamped by the surface at the moment it landed rather than the moment it happened. It is
   * also the one report a run makes while a *different* piece of infrastructure is failing, so
   * putting it at the back of a FIFO queue behind whatever is already stuck is exactly wrong.
   *
   * Failing loudly to its caller is safe here because the caller is `park.ts`'s `onParked` hook,
   * which cannot act on it: losing a park report costs a line on the timeline, and the next
   * attempt reports again a second or two later.
   */
  readonly reportSnapshotPark: (report: SnapshotParkReport) => Promise<void>
  /** The supervision queue. Nothing is pushed to this instance (FR-035). */
  readonly pullPendingCommands: () => Promise<PendingCommands>
  readonly acknowledgeCommand: (input: AcknowledgeCommandInput) => Promise<void>
  readonly reportBootstrapPhase: (report: BootstrapPhaseReport) => Promise<void>
  readonly registerArtifact: (input: RegisterArtifactInput) => Promise<void>
  readonly reportTerminal: (report: TerminalReport) => Promise<void>
  /**
   * Which skill this run read, and the digest that pins its version (FR-058, FR-059).
   *
   * Assignable to `SkillReferenceReporter` in `../skills`, which is the point: `resolveSkill`
   * already calls a callback of that shape on every resolution and every halt, and until this
   * existed the callback was bound to a function that discarded them — so `workflow.skillReferences`
   * read a table nothing had ever written to.
   *
   * Buffered, like the other durable records. A digest is still true whenever it lands, and losing
   * one loses the only answer to which version of a convention the run followed.
   */
  readonly reportSkillReference: (input: SkillReferenceInput) => Promise<void>
  /**
   * Claim an action before taking it outside the platform (FR-076, FR-077).
   *
   * **Direct, and it is the one call here where that is not a judgement about staleness.** Its
   * whole value is the response: `claimed` says whether this process is the one entitled to post
   * the comment, and `alreadyPerformed` says another process already did — which is what a
   * re-provisioned instance with an empty `../delivery/external-action.ts` ledger has no other way
   * to find out. Buffering it would return before the claim was decided, which is the same as not
   * asking.
   */
  readonly reportExternalAction: (input: ExternalActionInput) => Promise<ExternalActionClaim>
  /** Deliver everything buffered. Part of the FR-047 pre-termination path. */
  readonly flush: () => Promise<void>
  readonly pendingReports: number
  /** Latched if the buffer ever filled — the run's record is incomplete. */
  readonly isReportingDegraded: boolean
}

/** A segment built for one workflow must not be reported under another's credential. */
export const crossWorkflowSegmentError = (expected: string, given: string): Error =>
  new Error(
    `A log segment for workflow ${given} cannot be reported by the client for workflow ${expected}.`,
  )

export const createMachineSurfaceClient = (
  options: MachineSurfaceClientOptions,
): MachineSurfaceClient => {
  const outbox: Outbox = createOutbox({
    ...(options.maxBufferedReports === undefined ? {} : { maxEntries: options.maxBufferedReports }),
    ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.onSaturated === undefined ? {} : { onSaturated: options.onSaturated }),
  })

  return {
    // Direct: liveness and credential renewal are worthless when replayed, and
    // the three supervision-side calls have to have landed before the caller
    // acts on them (FR-049, SC-003).
    heartbeat: async (input) => options.transport.heartbeat(input),
    renewCredential: async () => options.transport.renewCredential(),
    registerSnapshot: async (input) => options.transport.registerSnapshot(input),
    reportSnapshotPark: async (report) => options.transport.reportSnapshotPark(report),
    pullPendingCommands: async () => options.transport.pullPendingCommands(),
    acknowledgeCommand: async (input) => options.transport.acknowledgeCommand(input),

    reportBootstrapPhase: async (report) =>
      outbox.enqueue({
        procedure: 'reportBootstrapPhase',
        send: async () => options.transport.reportBootstrapPhase(report),
      }),

    appendLogSegment: async (record: LogSegmentRecord) => {
      if (record.workflowId !== options.workflowId) {
        throw crossWorkflowSegmentError(options.workflowId, record.workflowId)
      }

      // `workflowId` is deliberately not forwarded: no machine input carries
      // one, because a payload that names its own workflow invites exactly the
      // cross-workflow write FR-018 makes a recorded security event.
      const input: AppendLogSegmentInput = {
        sequence: record.sequence,
        s3Key: record.s3Key,
        byteSize: record.byteSize,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
      }

      await outbox.enqueue({
        procedure: 'appendLogSegment',
        send: async () => options.transport.appendLogSegment(input),
      })
    },

    registerArtifact: async (input) =>
      outbox.enqueue({
        procedure: 'registerArtifact',
        send: async () => options.transport.registerArtifact(input),
      }),

    reportTerminal: async (report) =>
      outbox.enqueue({
        procedure: 'reportTerminal',
        send: async () => options.transport.reportTerminal(report),
      }),

    reportSkillReference: async (input) =>
      outbox.enqueue({
        procedure: 'reportSkillReference',
        send: async () => options.transport.reportSkillReference(input),
      }),

    // Direct: see the note on the interface. A buffered claim is not a claim.
    reportExternalAction: async (input) => options.transport.reportExternalAction(input),

    flush: async () => outbox.drain(),

    get pendingReports() {
      return outbox.pending
    },

    get isReportingDegraded() {
      return outbox.isSaturated
    },
  }
}
