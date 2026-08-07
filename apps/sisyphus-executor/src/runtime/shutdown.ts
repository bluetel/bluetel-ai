/**
 * Graceful-shutdown registry for the executor process.
 *
 * The executor is a long-lived process on an EC2 instance and can be asked to
 * stop from several directions at once — a SIGTERM from the supervisor, a
 * SIGINT from an interactive run, or an internal decision to wind down. Every
 * one of those has to converge on the same ordered cleanup, run exactly once:
 * a second signal must not re-enter the handlers halfway through the first.
 */

export type ShutdownHook = () => Promise<void> | void

export interface ShutdownReason {
  /** What asked the process to stop — a signal name, or an internal label. */
  readonly source: string
}

export interface ShutdownRegistry {
  /**
   * Register a cleanup hook. Hooks run in reverse registration order, so a
   * resource registered after the one it depends on is torn down first.
   * Returns a function that removes the hook again.
   */
  onShutdown: (hook: ShutdownHook) => () => void
  /**
   * Run every registered hook once, in reverse registration order. Later calls
   * — and calls that arrive while a shutdown is in flight — return the same
   * promise as the first. A hook that throws does not stop the remaining hooks;
   * its error is collected and reported.
   */
  shutdown: (reason: ShutdownReason) => Promise<ShutdownResult>
  /** True once `shutdown` has been called at least once. */
  readonly isShuttingDown: boolean
}

export interface ShutdownResult {
  readonly reason: ShutdownReason
  /** Errors thrown by hooks, in the order the hooks ran. */
  readonly errors: readonly Error[]
}

export const createShutdownRegistry = (): ShutdownRegistry => {
  const hooks: ShutdownHook[] = []
  let inFlight: Promise<ShutdownResult> | undefined

  const runAll = async (reason: ShutdownReason): Promise<ShutdownResult> => {
    const errors: Error[] = []

    for (const hook of [...hooks].reverse()) {
      try {
        await hook()
      } catch (thrown) {
        errors.push(thrown instanceof Error ? thrown : new Error(String(thrown)))
      }
    }

    hooks.length = 0

    return { reason, errors }
  }

  return {
    onShutdown: (hook: ShutdownHook) => {
      hooks.push(hook)

      return () => {
        const index = hooks.indexOf(hook)

        if (index !== -1) {
          hooks.splice(index, 1)
        }
      }
    },
    shutdown: (reason: ShutdownReason) => (inFlight ??= runAll(reason)),
    get isShuttingDown() {
      return inFlight !== undefined
    },
  }
}
