/**
 * The agent adapter boundary (T035).
 *
 * This is the single seam between the executor and whatever is actually
 * driving the coding agent. Research decision R1 chose NDJSON-on-stdin against
 * the Claude Code CLI as the primary implementation and held the Agent SDK as
 * the fallback; the fallback is only a module swap rather than a rewrite while
 * both satisfy this one interface. Nothing above this file may spawn a
 * process, write a frame, or read stdout directly.
 *
 * Everything here is deliberately transport-neutral: no child process, no file
 * descriptors, no CLI flags. `cli-stream.ts` (T056) supplies the NDJSON-stdin
 * implementation and `frames.ts` the defensive parser; the supervision layer
 * (T090-T093) and `suspend()` (T091) consume only what is declared below.
 */

/** Consumption as at a point in time. Both counters are monotonic. */
export interface AgentUsage {
  /** Assistant turns completed since `start`, including a resumed history. */
  readonly turns: number
  /**
   * Spend in USD as reported by the agent. Where the setup bundle's credential
   * makes spend unmeasurable the agent reports zero and the cap is advisory
   * (FR-093) — the turn count stays authoritative in that case.
   */
  readonly spendUsd: number
}

/** A lifecycle frame: session start, turn boundaries, compaction, and so on. */
export interface AgentSystemFrame {
  readonly type: 'system'
  /** e.g. `init`, `turn_starting`, `compact_boundary`. Never narrowed to a
   * closed union: an unfamiliar subtype is information, not a failure. */
  readonly subtype: string
  readonly sessionId?: string
}

/** Assistant output. `text` is raw — the output pipeline sanitises it. */
export interface AgentAssistantFrame {
  readonly type: 'assistant'
  readonly text: string
  readonly sessionId?: string
}

/**
 * A user turn echoed back by the agent. The CLI only emits these under
 * `--replay-user-messages`, which is how a correction gets an acknowledgement
 * rather than a hopeful write (FR-049, T093).
 */
export interface AgentUserFrame {
  readonly type: 'user'
  readonly text: string
  readonly sessionId?: string
}

/** Terminal frame for a request. `subtype` names the reason it ended. */
export interface AgentResultFrame {
  readonly type: 'result'
  /** e.g. `success`, `error_max_turns`, `error_max_budget_usd`. */
  readonly subtype: string
  readonly isError: boolean
  readonly usage: AgentUsage
  readonly sessionId?: string
}

/**
 * A frame that did not parse into any of the above. The wire format is only
 * lightly documented, so an unfamiliar frame is surfaced rather than dropped
 * silently: callers log it and carry on, and a run that produces a flood of
 * them is visibly wrong instead of quietly wrong.
 */
export interface AgentUnknownFrame {
  readonly type: 'unknown'
  /** The original line, verbatim, before sanitisation. */
  readonly raw: string
}

export type AgentFrame =
  | AgentSystemFrame
  | AgentAssistantFrame
  | AgentUserFrame
  | AgentResultFrame
  | AgentUnknownFrame

export interface AgentStartOptions {
  /**
   * The platform-assigned session identifier (FR-052). Assigned by the control
   * plane rather than parsed out of agent output, so a workflow is addressable
   * even if the run dies before producing any.
   */
  readonly sessionId: string
  /**
   * The pinned workspace root. Fixed on purpose: the agent derives its session
   * directory from the absolute working directory, so an unpinned path makes a
   * restored session unfindable (R2, FR-051).
   */
  readonly cwd: string
  readonly model: string
  /** The fully assembled prompt — the executor never assembles one itself. */
  readonly prompt: string
  /** Enforced locally as well; the agent's own limit is the second line. */
  readonly turnCap?: number
  /** Advisory where the bundle's credential makes spend unmeasurable. */
  readonly spendCapUsd?: number
  /**
   * Set only on the restore path, and set to the session identifier recorded
   * **in the snapshot**, which for a successor run is the predecessor's rather
   * than its own (FR-150). Conflating the two makes the resume find nothing.
   */
  readonly resumeSessionId?: string
  /**
   * Agent configuration directory, relocated inside the pinned root so the
   * whole state tree is one archive target (FR-051).
   */
  readonly configDir?: string
}

export interface AgentSendTurnOptions {
  /** Reject rather than wait forever; a correction must fail visibly (T093). */
  readonly timeoutMs?: number
}

/** Evidence that a turn actually reached the agent, not just the pipe. */
export interface AgentTurnDelivery {
  /**
   * True when the agent echoed the turn back. False means the write succeeded
   * but nothing confirmed receipt — which a correction must record as such
   * rather than report as delivered.
   */
  readonly acknowledged: boolean
  /** Milliseconds from writing the frame to observing the acknowledgement. */
  readonly latencyMs: number
}

export interface AgentQuiesceOptions {
  /**
   * How long to wait for a turn boundary. Bounded because SC-003 gives the
   * whole pause path ten seconds, of which this is one part.
   */
  readonly timeoutMs?: number
}

/** The state a snapshot is taken against. */
export interface AgentQuiescedState {
  /** Consumption as at the boundary — what the snapshot is registered with. */
  readonly usage: AgentUsage
  /** True when a turn was in flight and had to be waited out. */
  readonly waitedForTurn: boolean
}

export interface AgentStopOptions {
  /**
   * `false` asks the agent to end and waits; `true` kills the process group.
   * A graceful stop is attempted first everywhere except an interruption whose
   * deadline has already passed.
   */
  readonly force: boolean
  readonly timeoutMs?: number
}

export interface AgentStopResult {
  readonly exitCode: number | null
  /** Signal name if the agent was killed, otherwise null. */
  readonly signal: string | null
  /** True when a graceful stop timed out and the process group was killed. */
  readonly forced: boolean
}

/**
 * Why an adapter call failed. Named rather than free text because the reasons
 * end up in acknowledgements the panel renders (FR-049, T093).
 */
export type AgentFailureKind =
  | 'not-started'
  | 'already-stopped'
  | 'spawn-failed'
  | 'delivery-failed'
  | 'quiesce-timeout'
  | 'protocol'

export class AgentAdapterError extends Error {
  readonly kind: AgentFailureKind

  constructor(kind: AgentFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentAdapterError'
    this.kind = kind
  }
}

/**
 * Both the NDJSON-stdin implementation and the Agent SDK fallback satisfy this.
 *
 * Rules that are part of the contract, not of any one implementation:
 *
 * - `sendTurn` MUST NOT restart the agent (FR-044). A correction that costs a
 *   restart is a restore cycle wearing a correction's clothes.
 * - `quiesce` reaches a turn boundary without terminating (FR-049). It is what
 *   makes pause non-destructive, so it may not be implemented as a kill.
 * - `output` is a single-consumer stream. Frames are parsed defensively: an
 *   unfamiliar frame arrives as `AgentUnknownFrame` and is never fatal.
 * - `usage` reads the latest figures seen on `output`; it never blocks and
 *   never queries the agent, so a caps check costs nothing.
 */
export interface AgentAdapter {
  /**
   * Spawn or connect, deliver the opening prompt, and resolve once the agent
   * has acknowledged the session. Rejects with `spawn-failed` if the agent
   * never becomes ready — the workflow fails naming the agent-start phase
   * rather than emitting a generic bootstrap timeout (FR-145).
   */
  start: (options: AgentStartOptions) => Promise<void>
  /**
   * Deliver one additional user turn into the **live** conversation. Rejects
   * with `delivery-failed` when the turn cannot be delivered; the caller
   * acknowledges the correction as failed with that reason rather than
   * dropping it (FR-049).
   */
  sendTurn: (body: string, options?: AgentSendTurnOptions) => Promise<AgentTurnDelivery>
  /**
   * Wait for the current turn to finish, leaving the agent alive and idle.
   * Rejects with `quiesce-timeout` if no boundary is reached in time — the
   * caller must not snapshot mid-turn on the assumption that it did.
   */
  quiesce: (options?: AgentQuiesceOptions) => Promise<AgentQuiescedState>
  /** End the session. Safe to call more than once; the second call is a no-op. */
  stop: (options: AgentStopOptions) => Promise<AgentStopResult>
  /** Frames in arrival order. Completes when the agent exits. */
  readonly output: AsyncIterable<AgentFrame>
  /** Latest consumption. Read freely; this is a field, not a round trip. */
  readonly usage: AgentUsage
}
