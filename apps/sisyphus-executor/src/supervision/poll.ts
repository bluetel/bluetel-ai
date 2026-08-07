/**
 * **How a pause actually arrives on the instance (T090, FR-049, SC-003).**
 *
 * The panel writes a row into `supervision_commands`. Nothing else on this instance would ever
 * observe it — there is no ingress path to the executor and there is not meant to be (FR-035) — so
 * this loop is the entire mechanism by which a pause becomes something the agent experiences. Delete
 * it and `suspend()` is fully specified and never invoked.
 *
 * ## Three rules, and each one is a defect if it is dropped
 *
 * 1. **`sequence` order, always.** Not arrival order, not `created_at`. The API allocates `sequence`
 *    under the workflow row lock, which is what makes it a total order; applying in any other order
 *    would make the lock pointless.
 * 2. **A `superseded` command is acknowledged and never applied.** The pull returns superseded rows
 *    deliberately — a row the executor never sees is a row that stays uncollected forever — and this
 *    loop's job is to close them out without acting on them. A `pause` overtaken by a `stop` must not
 *    pause, acknowledge, and only then discover it was also asked to stop.
 * 3. **One command at a time, and a failure stops the batch.** If `pause` fails to apply, the `stop`
 *    behind it in the same batch is left pending rather than being applied against a run whose state
 *    is now unknown. It is collected again on the next poll, which is a delay; applying it anyway
 *    would be a guess.
 *
 * ## Bounded interval, and the arithmetic
 *
 * See `./budget.ts`. The interval is 2000 ms of a 10 000 ms ceiling, and the whole path — interval,
 * pull, quiesce, snapshot, acknowledge — is budgeted at 9000 ms with a second held back.
 *
 * ## What this file does not assume
 *
 * It never reasons about the agent's scheduling. Spike S1 proved the NDJSON transport against a stub
 * and recorded plainly that whether the real CLI hands a mid-request stdin turn to the in-flight
 * request or queues it behind the current one was **not observed**. So nothing here counts turns,
 * predicts when a boundary will fall, or assumes an applied command takes effect before the next
 * one is read. It applies, waits for the handler to say it is done, and moves on.
 */

import { POLL_INTERVAL_MS } from './budget'

/** The three things a person can ask of a live run. */
export type SupervisionCommandName = 'pause' | 'resume' | 'stop'

/** What the executor reports back about a command. */
export type SupervisionAcknowledgementOutcome = 'acknowledged' | 'superseded' | 'rejected'

/** One row as the machine surface returns it. */
export interface CollectedCommand {
  readonly id: string
  readonly command: SupervisionCommandName
  readonly sequence: number
  /** `pending` — apply it. `superseded` — acknowledge it and do **not** apply it. */
  readonly deliveryOutcome: 'pending' | 'superseded'
  readonly failureReason: string | null
}

/** What the executor sends back for one command. */
export interface CommandAcknowledgement {
  readonly commandId: string
  readonly outcome: SupervisionAcknowledgementOutcome
  readonly failureReason?: string
}

/**
 * The machine-surface calls this loop makes. Two methods, injected, so the loop is testable without
 * a network and so nothing here knows what a tRPC client is.
 */
export interface SupervisionTransport {
  readonly pullPendingCommands: () => Promise<readonly CollectedCommand[]>
  readonly acknowledgeCommand: (acknowledgement: CommandAcknowledgement) => Promise<void>
}

/**
 * What applying a command actually does.
 *
 * `pause` and `stop` enter `suspend()` (`session/suspend.ts`); `resume` is handled by the control
 * plane provisioning a fresh instance from the snapshot, **not** by this executor, so the default
 * handler for it acknowledges and does nothing. That asymmetry is from the protocol, not an
 * omission, and it is why `onResume` is optional while the other two are not.
 */
export interface SupervisionHandlers {
  readonly onPause: () => Promise<void>
  readonly onStop: () => Promise<void>
  /** Optional: an instance that can carry on without being reprovisioned may supply one. */
  readonly onResume?: () => Promise<void>
}

/** One command's fate, as the poller records it. */
export interface AppliedCommand {
  readonly commandId: string
  readonly command: SupervisionCommandName
  readonly sequence: number
  readonly outcome: SupervisionAcknowledgementOutcome
  /** False for a superseded command — recorded, so "never applied" is checkable, not asserted. */
  readonly applied: boolean
  readonly failureReason?: string
}

/** What one pass over the queue did. */
export interface PollCycleResult {
  readonly collected: number
  readonly handled: readonly AppliedCommand[]
  /** True when a command failed to apply and the rest of the batch was left for the next pass. */
  readonly haltedEarly: boolean
}

export interface SupervisionPollerOptions {
  readonly transport: SupervisionTransport
  readonly handlers: SupervisionHandlers
  /** Defaults to {@link POLL_INTERVAL_MS}; see `./budget.ts` before changing it. */
  readonly intervalMs?: number
  /** Injected so a test drives the clock rather than waiting on it. */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /**
   * Called when a cycle throws — a pull that could not reach the API, say. The loop continues:
   * an unreachable machine surface is a transient the executor retries through (FR-047), not a
   * reason to stop listening for a pause.
   */
  readonly onCycleError?: (error: unknown) => void
}

export interface SupervisionPoller {
  /** One pass over the queue. Exposed so a test can step the loop rather than race it. */
  readonly cycle: () => Promise<PollCycleResult>
  /** Poll until {@link SupervisionPoller.stop}. Resolves once the loop has actually finished. */
  readonly run: () => Promise<void>
  readonly stop: () => void
  readonly isRunning: () => boolean
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })

/**
 * Commands in the order they must be applied.
 *
 * Exported because rule 1 is worth asserting directly rather than through the loop that uses it.
 */
export const inSequenceOrder = <TCommand extends { readonly sequence: number }>(
  commands: readonly TCommand[],
): readonly TCommand[] => [...commands].sort((left, right) => left.sequence - right.sequence)

/** The message an unapplied command carries back, so a failure is legible in the panel. */
const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createSupervisionPoller = (options: SupervisionPollerOptions): SupervisionPoller => {
  const { transport, handlers } = options
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const sleep = options.sleep ?? defaultSleep

  let running = false
  let stopRequested = false

  const applyOne = async (command: SupervisionCommandName): Promise<void> => {
    if (command === 'pause') {
      await handlers.onPause()

      return
    }

    if (command === 'stop') {
      await handlers.onStop()

      return
    }

    await handlers.onResume?.()
  }

  const cycle = async (): Promise<PollCycleResult> => {
    const collected = inSequenceOrder(await transport.pullPendingCommands())
    const handled: AppliedCommand[] = []

    for (const command of collected) {
      // Rule 2. A superseded command is closed out without ever reaching a handler, so the
      // "never applied" guarantee is a property of the control flow rather than of a handler
      // remembering to check.
      if (command.deliveryOutcome === 'superseded') {
        await transport.acknowledgeCommand({
          commandId: command.id,
          outcome: 'superseded',
          failureReason: command.failureReason ?? undefined,
        })
        handled.push({
          commandId: command.id,
          command: command.command,
          sequence: command.sequence,
          outcome: 'superseded',
          applied: false,
        })

        continue
      }

      try {
        await applyOne(command.command)
      } catch (error) {
        const failureReason = describeFailure(error)

        await transport.acknowledgeCommand({
          commandId: command.id,
          outcome: 'rejected',
          failureReason,
        })
        handled.push({
          commandId: command.id,
          command: command.command,
          sequence: command.sequence,
          outcome: 'rejected',
          applied: false,
          failureReason,
        })

        // Rule 3. Whatever is behind this in the batch is left pending and collected next pass.
        return { collected: collected.length, handled, haltedEarly: true }
      }

      await transport.acknowledgeCommand({ commandId: command.id, outcome: 'acknowledged' })
      handled.push({
        commandId: command.id,
        command: command.command,
        sequence: command.sequence,
        outcome: 'acknowledged',
        applied: true,
      })
    }

    return { collected: collected.length, handled, haltedEarly: false }
  }

  /**
   * Read through a function rather than the variable directly.
   *
   * `stop()` is called from *outside* this loop — from a signal handler, or from a test's fake
   * sleep — so the flag changes while the loop is suspended at an `await`. Reading the closed-over
   * variable inline lets the type checker narrow it to the value it had at the top of the iteration
   * and conclude the re-check is dead code, which it is not. Going through a call restores the
   * honest answer.
   */
  const shouldStop = (): boolean => stopRequested

  const run = async (): Promise<void> => {
    running = true
    stopRequested = false

    try {
      while (!shouldStop()) {
        try {
          await cycle()
        } catch (error) {
          options.onCycleError?.(error)
        }

        // Between cycles, never mid-batch: a stop that abandoned half a batch would leave commands
        // applied and unacknowledged, which the next instance would apply again.
        if (shouldStop()) {
          break
        }

        await sleep(intervalMs)
      }
    } finally {
      running = false
    }
  }

  return {
    cycle,
    run,
    stop: () => {
      stopRequested = true
    },
    isRunning: () => running,
  }
}
