/**
 * **Reporting a park to the platform (T184, FR-082, FR-048).**
 *
 * `session/park.ts` has called `onParked` before every wait since T092, and its own module comment
 * says why: "the workflow reports a distinct parked reason so the panel can say *waiting on
 * storage* rather than showing a stalled pause". Until this module the only thing bound to that
 * hook wrote a line of log text. A log line is not a fact anything can query — no screen could
 * distinguish a run holding at a boundary and retrying from a run that had simply stopped
 * producing output, which is precisely the reading FR-082 exists to rule out.
 *
 * So a park now goes two places, and both are load-bearing:
 *
 * - the **log**, unchanged, because the operator reading output at the moment it happens should
 *   see it there rather than have to go and look at a card;
 * - `machine.reportSnapshotPark`, which records the boundary, the attempt and the budget against
 *   the run, so the panel can say what is happening and that it is being retried.
 *
 * ## Nothing here may throw, and nothing here may block
 *
 * `onParked` is `(report) => void` on purpose. It is called from inside the retry loop between an
 * attempt failing and the backoff sleep, and that loop is holding a quiesced agent: anything that
 * rejected out of it would turn a storage blip into a lost snapshot, and anything that *awaited*
 * would add its own latency to a wait that is already the thing being measured. So the report is
 * dispatched and not awaited, and its failure is routed to `onReportingFailure` — the same
 * treatment a failed heartbeat gets, and for the same reason. The next attempt reports again a
 * second or two later.
 *
 * ## The heartbeat is what makes parking survivable, and it is not this module's job
 *
 * A parked run must keep beating or the reconciler sweeps it as heartbeat-lapsed and destroys an
 * instance that is healthy and waiting. That property does not come from anything here: the
 * heartbeat loop in `./heartbeat.ts` is an independent task started before the agent, and a park
 * suspends only the supervision handler that called it. `./heartbeat.test.ts` holds the test that
 * proves a park does not stop it.
 */

import type { SanitisedText, SecretSource } from '../output'
import { sanitise } from '../output'
import type { MachineSurfaceClient } from '../report'
import type { ParkReport } from '../session'

/** What a park reporter needs. */
export interface ParkReporterOptions {
  readonly client: Pick<MachineSurfaceClient, 'reportSnapshotPark'>
  /** The run's log stream, so the operator watching output sees it as it happens. */
  readonly log: (line: string) => Promise<void>
  /**
   * The values this run knows, so a quoted request URL is redacted (FR-072, 003/FR-014).
   *
   * A {@link SecretSource} rather than an array, because a park can happen at any point in a run —
   * including after the agent has rotated its own credential — and a snapshot of the values taken
   * when this reporter was built would not know the newest one.
   */
  readonly secrets?: SecretSource
  /** Reported and never fatal — a lost park report must not cost a snapshot. */
  readonly onReportingFailure?: (error: unknown, detail: string) => void
}

/**
 * The line a park writes to the run's output.
 *
 * Exported so the wording is asserted rather than inferred from a mock. It names the boundary and
 * the attempt out of the budget, because "retrying" and "retrying, three tries left" are different
 * operational facts and only the second one tells anybody whether to wait.
 */
export const parkLogLine = (report: ParkReport): string =>
  `[suspend] storage is unreachable; holding at the ${report.boundary} boundary and retrying ` +
  `(attempt ${String(report.attempt)} of ${String(report.maxAttempts)}, ` +
  `next in ${String(report.nextDelayMs)}ms): ${report.reason}\n`

/**
 * Build the `onParked` hook `suspend()` and `restore()` take.
 *
 * @param options - See {@link ParkReporterOptions}.
 * @returns A hook that logs the park and reports it, and that never rejects.
 */
export const createParkReporter = (
  options: ParkReporterOptions,
): ((report: ParkReport) => void) => {
  const secrets = options.secrets

  return (report) => {
    // Caught rather than `void`-ed. The run's own `log` swallows its failures, but this seam takes
    // any writer, and an unhandled rejection escaping a hook that holds a quiesced agent would end
    // the process on `--unhandled-rejections=throw`.
    void options.log(parkLogLine(report)).catch((error: unknown) => {
      options.onReportingFailure?.(error, 'logging a park')
    })

    const detail: SanitisedText = sanitise(report.reason, secrets === undefined ? {} : { secrets })

    // Deliberately not awaited. See the module comment: the caller is a retry loop holding a
    // quiesced agent, and the cost of a lost report is one timeline entry.
    void options.client
      .reportSnapshotPark({
        boundary: report.boundary,
        attempt: report.attempt,
        maxAttempts: report.maxAttempts,
        nextDelayMs: report.nextDelayMs,
        detail,
      })
      .catch((error: unknown) => {
        options.onReportingFailure?.(
          error,
          `reporting a park at the ${report.boundary} boundary (attempt ${String(report.attempt)})`,
        )
      })
  }
}
