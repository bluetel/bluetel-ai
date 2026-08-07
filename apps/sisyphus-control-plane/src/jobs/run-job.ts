/**
 * Uniform invocation wrapper for control-plane jobs.
 *
 * Every job in this app is invoked internally — in-process or by EventBridge
 * Scheduler — never over an inbound network surface (FR-035). `runJob` gives
 * those invocations one shape: a job either succeeds with a value or fails with
 * a captured error, and either way the caller gets the elapsed duration for the
 * run so scheduled invocations can be logged and alerted on consistently.
 */

export interface JobContext {
  /** Stable name of the job, used for logging and metrics. */
  readonly jobName: string
}

export type JobHandler<TResult> = (context: JobContext) => Promise<TResult> | TResult

interface JobOutcomeBase {
  readonly jobName: string
  /** Wall-clock duration of the handler, in whole milliseconds. */
  readonly durationMs: number
}

export interface JobSuccess<TResult> extends JobOutcomeBase {
  readonly ok: true
  readonly value: TResult
}

export interface JobFailure extends JobOutcomeBase {
  readonly ok: false
  readonly error: Error
}

export type JobOutcome<TResult> = JobFailure | JobSuccess<TResult>

/** Coerce an unknown thrown value into an `Error` without losing its content. */
export const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown))

/**
 * Run `handler` and capture its outcome. Never throws: a rejected or throwing
 * handler is reported as `{ ok: false, error }` so a scheduled invocation can
 * record the failure rather than dying with an unhandled rejection.
 */
export const runJob = async <TResult>(
  jobName: string,
  handler: JobHandler<TResult>,
  now: () => number = Date.now,
): Promise<JobOutcome<TResult>> => {
  const startedAt = now()

  try {
    const value = await handler({ jobName })

    return { ok: true, jobName, durationMs: now() - startedAt, value }
  } catch (thrown) {
    return { ok: false, jobName, durationMs: now() - startedAt, error: toError(thrown) }
  }
}
