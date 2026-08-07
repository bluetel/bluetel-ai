import { createControlPlaneContext } from './context'
import type { ControlPlaneInvocationSummary } from './dispatch'
import { parseControlPlaneEvent, runControlPlaneEvent, summariseInvocation } from './dispatch'

/**
 * The control plane's Lambda entry point — `src/main.handler`, as `sst.config.ts` declares it.
 *
 * Four steps and no fifth: parse the event, resolve the configuration, dispatch, report. The
 * routing lives in `dispatch.ts` and the wiring in `context.ts`, so what is left here is the shape
 * of an invocation — which is the one thing a handler should be readable for.
 *
 * ## Order matters: parse before anything is resolved
 *
 * An event naming no known job is refused before the environment is read or a pool is opened. A
 * handler that validated its configuration first would answer "invoked with a payload naming no
 * job" with "DATABASE_URL is missing", and the operator would go and look at the wrong thing.
 *
 * ## Why the environment is imported inside the handler
 *
 * `env.ts` validates at import, and a module-scope import would make a missing variable a Lambda
 * *initialisation* error: no event, no job name, and a retry storm against a container that cannot
 * start. Imported here it is an invocation failure naming the variable. `bootstrap-admins.ts` makes
 * the same choice for the same reason, and Node caches the module, so a warm container pays for
 * this once.
 *
 * ## A failed job fails the invocation
 *
 * `runJob` captures failures rather than throwing, which is what lets the stage tick run all three
 * of its steps when one of them is broken. But an invocation whose jobs all failed must not return
 * 200 to EventBridge Scheduler: nothing is watching the response body, and the `Errors` metric is
 * the only signal that a schedule has been firing into a broken platform. So the summary is logged
 * either way, and a failure is then rethrown naming every job that failed.
 */

/**
 * @param event - The raw payload: a schedule's `Input`, or a direct invocation's body.
 * @returns The per-job summary, on success.
 * @throws If the event names no known job, if the environment is invalid, or if any job failed.
 */
export const handler = async (event: unknown): Promise<ControlPlaneInvocationSummary> => {
  const parsed = parseControlPlaneEvent(event)

  const { env } = await import('./env')
  const context = createControlPlaneContext({ env })

  const summary = summariseInvocation(parsed, await runControlPlaneEvent(context, parsed))

  const failures = summary.jobs.filter((job) => !job.ok)

  if (failures.length === 0) {
    console.info(JSON.stringify(summary))
    return summary
  }

  console.error(JSON.stringify(summary))

  throw new Error(
    `The control plane ran ${summary.jobs.length} job(s) for "${summary.job}" and ${failures.length} failed: ` +
      failures.map((job) => `${job.jobName}: ${job.error ?? 'no message'}`).join('; '),
  )
}
