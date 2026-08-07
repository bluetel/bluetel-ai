/**
 * The NDJSON-stdin `AgentAdapter` (T056).
 *
 * R1's primary implementation: one long-lived `claude --print` process, frames
 * out on stdout, additional user turns in on stdin. Keeping the process alive
 * is the whole design — a correction is a line written to a pipe, not a restart
 * (FR-044), and pause is a wait for a turn boundary, not a kill (FR-049).
 *
 * Three things this file deliberately does **not** do:
 *
 * - **It does not assume the CLI's scheduling.** Spike S1 proved the transport
 *   against a stub and recorded, plainly, that whether the real CLI hands a
 *   mid-request stdin turn to the in-flight request or queues it behind the
 *   current one was never observed. So nothing here counts expected `result`
 *   frames or reasons about which turn a frame belongs to. `quiesce` waits for
 *   the *next* boundary; that is correct under either scheduling, and a design
 *   that counted would be correct under only one.
 * - **It does not sanitise.** `AgentFrame.text` is raw by contract and the
 *   output pipeline owns strip-then-redact. An adapter that sanitised would be
 *   doing it without the bundle's known credential values, which is the half of
 *   redaction that catches a client credential in an unanticipated format.
 * - **It does not interpret an unfamiliar frame.** Unknown frames are reported
 *   to `onUnknownFrame` and passed on. The wire format is lightly documented;
 *   a run must survive a frame type added in a CLI release.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'

import type {
  AgentAdapter,
  AgentFrame,
  AgentQuiesceOptions,
  AgentQuiescedState,
  AgentSendTurnOptions,
  AgentStartOptions,
  AgentStopOptions,
  AgentStopResult,
  AgentTurnDelivery,
  AgentUnknownFrame,
  AgentUsage,
} from './adapter'
import { AgentAdapterError } from './adapter'
import { createFrameStream } from './frame-stream'
import type { FrameStream } from './frame-stream'
import { createFrameDecoder, encodeUserTurn } from './frames'
import { claudeProcessSpec } from './invocation'
import type { AgentProcessSpecFactory } from './invocation'

/** Long enough for a cold CLI start; the bootstrap phase timeout is the real limit. */
const DEFAULT_START_TIMEOUT_MS = 60_000
/** A correction that cannot be confirmed quickly is reported unconfirmed, not awaited forever. */
const DEFAULT_SEND_TURN_TIMEOUT_MS = 10_000
/** SC-003 gives the whole pause path ten seconds, of which this is one part. */
const DEFAULT_QUIESCE_TIMEOUT_MS = 8_000
/** After this a graceful stop becomes a SIGKILL to the process group. */
const DEFAULT_STOP_TIMEOUT_MS = 10_000

export interface CliStreamAdapterOptions {
  /**
   * How the process is invoked. Defaults to the real CLI; T057 substitutes the
   * stub agent process so the loop is exercised without paid inference.
   */
  readonly processSpec?: AgentProcessSpecFactory
  /**
   * Called for every frame the parser did not recognise, before it is passed
   * on. The default reports the size and nothing else — see
   * {@link logUnknownFrame}.
   */
  readonly onUnknownFrame?: (frame: AgentUnknownFrame) => void
  /** Base environment for the child. Defaults to the executor's own. */
  readonly env?: NodeJS.ProcessEnv
  readonly startTimeoutMs?: number
  readonly sendTurnTimeoutMs?: number
  readonly quiesceTimeoutMs?: number
  readonly stopTimeoutMs?: number
  /** Injected in tests so latency is measured rather than assumed. */
  readonly now?: () => number
}

/**
 * The default unknown-frame log.
 *
 * It reports the byte length and **not** the content, and that is not
 * squeamishness. `AgentUnknownFrame.raw` is unsanitised agent output; writing
 * it to the executor's stderr would put a copy that has not been redacted somewhere the
 * strip-and-redact pipeline never sees, which is exactly the
 * unsanitised-copy-at-rest failure FR-045 and FR-089 exist to prevent. The raw
 * text stays on the frame, travels the ordinary output path, and gets redacted
 * there like everything else.
 */
export const logUnknownFrame = (frame: AgentUnknownFrame): void => {
  process.stderr.write(
    `agent: skipped an unrecognised frame (${frame.raw.length} characters); ` +
      'the wire format is lightly documented and this is not fatal\n',
  )
}

const monotonicUsage = (previous: AgentUsage, next: AgentUsage): AgentUsage => ({
  turns: Math.max(previous.turns, next.turns),
  spendUsd: Math.max(previous.spendUsd, next.spendUsd),
})

interface ProcessHandle {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<AgentStopResult>
}

/**
 * Kill the whole process group.
 *
 * The agent spawns tools, which spawn their own children. Signalling the leader
 * alone leaves a `git` or a test runner holding the workspace open on an
 * instance we are about to tear down — behaviour carried over deliberately from
 * the POC (executor-protocol.md → Explicitly not carried over). Spawning
 * detached is what makes the negative pid a group.
 */
const killGroup = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal)

      return
    }
  } catch {
    // The group is already gone, or the platform refused the negative pid.
    // Fall through to the single-process kill rather than failing a stop.
  }

  child.kill(signal)
}

export const createCliStreamAdapter = (options: CliStreamAdapterOptions = {}): AgentAdapter => {
  const specFactory = options.processSpec ?? claudeProcessSpec
  const onUnknownFrame = options.onUnknownFrame ?? logUnknownFrame
  const now = options.now ?? Date.now
  const stream: FrameStream = createFrameStream({ now })

  let handle: ProcessHandle | undefined
  let started = false
  let stopping: Promise<AgentStopResult> | undefined
  let usage: AgentUsage = { turns: 0, spendUsd: 0 }
  /**
   * True from writing a user turn until the next `result`. A boolean and not a
   * counter: how many results a given set of turns produces is a property of
   * the CLI's scheduling, and S1 did not observe it.
   */
  let turnInFlight = false

  const observe = (frame: AgentFrame, fromStdout: boolean): void => {
    if (frame.type === 'result') {
      usage = monotonicUsage(usage, frame.usage)
      turnInFlight = false
    }

    if (frame.type === 'unknown' && fromStdout) {
      onUnknownFrame(frame)
    }

    stream.emit(frame)
  }

  const attach = (child: ChildProcessWithoutNullStreams): ProcessHandle => {
    const decoder = createFrameDecoder()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const frame of decoder.push(chunk)) {
        observe(frame, true)
      }
    })

    // Anything on stderr is agent output too, and the adapter has no secrets to
    // redact it with. Routing it into the same frame stream keeps it on the one
    // path that ends at the sanitiser; giving it a side channel would be giving
    // it a way to reach a log without being redacted. It does not go to `onUnknownFrame`,
    // which exists to make a *protocol* surprise visible.
    const stderrDecoder = createFrameDecoder()

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const frame of stderrDecoder.push(chunk)) {
        observe(frame, false)
      }
    })

    const exited = new Promise<AgentStopResult>((resolveExit) => {
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        for (const frame of [...decoder.flush(), ...stderrDecoder.flush()]) {
          observe(frame, false)
        }

        stream.close()
        resolveExit({ exitCode: code, signal, forced: false })
      })
    })

    return { child, exited }
  }

  const writeLine = async (line: string): Promise<void> => {
    const child = handle?.child

    if (child?.stdin.writable !== true) {
      throw new AgentAdapterError(
        'delivery-failed',
        'the agent process is not accepting input; the turn was not delivered',
      )
    }

    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(`${line}\n`, (error) => {
        if (error === null || error === undefined) {
          resolveWrite()

          return
        }

        rejectWrite(
          new AgentAdapterError(
            'delivery-failed',
            `writing to the agent failed: ${error.message}`,
            {
              cause: error,
            },
          ),
        )
      })
    })
  }

  const start = async (startOptions: AgentStartOptions): Promise<void> => {
    if (handle !== undefined) {
      throw new AgentAdapterError('protocol', 'the agent has already been started')
    }

    const spec = specFactory(startOptions)

    let child: ChildProcessWithoutNullStreams

    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: startOptions.cwd,
        env: { ...(options.env ?? process.env), ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so `stop` can take the tools down with it.
        detached: true,
      })
    } catch (cause) {
      throw new AgentAdapterError('spawn-failed', `could not spawn ${spec.command}`, { cause })
    }

    handle = attach(child)

    const spawnFailure = new Promise<AgentAdapterError>((resolveFailure) => {
      child.once('error', (error: Error) => {
        resolveFailure(
          new AgentAdapterError(
            'spawn-failed',
            `could not spawn ${spec.command}: ${error.message}`,
            {
              cause: error,
            },
          ),
        )
      })
    })

    // The session acknowledgement. Waiting for it is what makes a failure to
    // start fail *here*, naming the agent-start phase, rather than surfacing
    // later as an agent that never says anything (FR-145).
    const ready = await Promise.race([
      stream.waitFor(
        (frame) => frame.type === 'system',
        options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      ),
      spawnFailure,
    ])

    if (ready instanceof AgentAdapterError) {
      throw ready
    }

    if (ready.kind !== 'matched') {
      const detail =
        ready.kind === 'closed'
          ? 'the process exited before acknowledging the session'
          : `no session acknowledgement within ${ready.waitedMs}ms`

      throw new AgentAdapterError('spawn-failed', `the agent did not start: ${detail}`)
    }

    started = true

    // The opening prompt is an ordinary user turn on the same stream every
    // correction uses. One path in, exercised on every single run.
    await writeLine(encodeUserTurn(startOptions.prompt))
    turnInFlight = true
  }

  const sendTurn = async (
    body: string,
    turnOptions: AgentSendTurnOptions = {},
  ): Promise<AgentTurnDelivery> => {
    if (!started) {
      throw new AgentAdapterError('not-started', 'cannot send a turn before the agent has started')
    }

    if (stopping !== undefined || stream.isClosed) {
      throw new AgentAdapterError('already-stopped', 'the agent session has ended')
    }

    const timeoutMs =
      turnOptions.timeoutMs ?? options.sendTurnTimeoutMs ?? DEFAULT_SEND_TURN_TIMEOUT_MS

    // Registered before the write, so an echo that comes back faster than the
    // promise chain resumes is still caught.
    const acknowledgement = stream.waitFor(
      (frame) => frame.type === 'user' && frame.text === body,
      timeoutMs,
    )

    await writeLine(encodeUserTurn(body))
    turnInFlight = true

    const outcome = await acknowledgement

    if (outcome.kind === 'closed') {
      throw new AgentAdapterError(
        'delivery-failed',
        'the agent session ended before the turn was acknowledged',
      )
    }

    // A timeout is *not* a failure here. The write succeeded; what is unknown
    // is whether the agent acted on it, and `acknowledged: false` says exactly
    // that. Reporting it as delivered would be the lie FR-049 forbids.
    return { acknowledged: outcome.kind === 'matched', latencyMs: outcome.waitedMs }
  }

  const quiesce = async (quiesceOptions: AgentQuiesceOptions = {}): Promise<AgentQuiescedState> => {
    if (!started) {
      throw new AgentAdapterError('not-started', 'cannot quiesce before the agent has started')
    }

    if (!turnInFlight || stream.isClosed) {
      return { usage, waitedForTurn: false }
    }

    /*
     * Waiting for the next `result` frame, not sending `control_request` with
     * subtype `interrupt`. S1 found that channel and flagged it as a candidate
     * lever to evaluate here; evaluated, it is the wrong one. An interrupt ends
     * a turn, and `quiesce` exists to reach a boundary **without** terminating
     * anything, so that the snapshot taken after it contains completed work
     * (FR-049). Its behaviour was also never observed. A destructive mechanism
     * on unobserved behaviour is two risks where the requirement needs none.
     */
    const outcome = await stream.waitFor(
      (frame) => frame.type === 'result',
      quiesceOptions.timeoutMs ?? options.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS,
    )

    if (outcome.kind === 'timed-out') {
      throw new AgentAdapterError(
        'quiesce-timeout',
        `no turn boundary reached within ${outcome.waitedMs}ms; ` +
          'the caller must not snapshot on the assumption that one was',
      )
    }

    return { usage, waitedForTurn: true }
  }

  const stop = (stopOptions: AgentStopOptions): Promise<AgentStopResult> => {
    const current = handle

    if (current === undefined) {
      return Promise.resolve({ exitCode: null, signal: null, forced: false })
    }

    stopping ??= (async (): Promise<AgentStopResult> => {
      if (stopOptions.force) {
        killGroup(current.child, 'SIGKILL')

        return { ...(await current.exited), forced: true }
      }

      // Closing stdin is the graceful ask: the CLI treats stdin as a
      // session-lifetime stream, so end-of-input is end-of-session.
      if (current.child.stdin.writable) {
        current.child.stdin.end()
      }

      const graceMs = stopOptions.timeoutMs ?? options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
      const timer = new Promise<'timeout'>((resolveTimer) => {
        const handleTimer = setTimeout(() => {
          resolveTimer('timeout')
        }, graceMs)

        handleTimer.unref()
      })

      const raced = await Promise.race([current.exited, timer])

      if (raced !== 'timeout') {
        return raced
      }

      killGroup(current.child, 'SIGKILL')

      return { ...(await current.exited), forced: true }
    })()

    return stopping
  }

  return {
    start,
    sendTurn,
    quiesce,
    stop,
    output: stream.iterable,
    get usage() {
      return usage
    },
  }
}
