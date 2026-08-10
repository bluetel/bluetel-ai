/**
 * **The validation-surface client (T200, FR-147, FR-148).**
 *
 * The sibling of `./client.ts`, and much smaller for a reason that is worth naming rather than
 * inferring: **a validation run speaks once.** It has no heartbeat, because nothing is watching a
 * liveness clock it could satisfy — `abandonStaleValidationRuns` bounds it at 45 minutes of
 * wall-clock and that is the whole supervision story. It has no log segments, no artifacts, no
 * snapshot, no supervision queue and no terminal report, because it has no agent, no workspace and
 * no workflow row for any of those to hang off. It says what the bootstrap phases did, once, and
 * exits.
 *
 * So there is no outbox here. The outbox exists because a workflow makes hundreds of durable
 * records over hours and must not lose the early ones (FR-047); a validation makes one, and a
 * FIFO buffer of one is a retry loop with extra machinery. What it does have is the same backoff —
 * this report is the entire product of the run, and a validation whose report is lost is
 * indistinguishable from one whose executor died, which is the case
 * {@link import('../../../sisyphus-control-plane/src/jobs/validate-bundle').abandonStaleValidationRuns}
 * writes a `timed_out` over. Retrying it hard is therefore not defensive; it is the difference
 * between a proof and a 45-minute silence.
 *
 * ## The type-only boundary holds here exactly as it does next door
 *
 * The only thing taken from `@bluetel-ai/sisyphus-api` is types, through `/client`, with
 * `import type`. `boundary.test.ts` bundles this directory with esbuild and fails if `postgres` or
 * `drizzle` appears in the output, so this module is covered by that assertion already (FR-005,
 * FR-006).
 *
 * ## Free text is `SanitisedText`, and here it is the *only* thing being reported
 *
 * `detail` on a phase result is where a failed `setup.sh` ends up — which is to say it is a
 * client's build output, on the one code path whose entire purpose is to run a client's script and
 * report what it said. So the input type below narrows the router's `string` to the branded type,
 * and an unsanitised message is a compile error at the call site rather than a redaction someone
 * remembered (FR-045, FR-089).
 */

import type {
  MachineRouter,
  MachineRouterInputs,
  MachineRouterOutputs,
} from '@bluetel-ai/sisyphus-api/client'
import { createTRPCClient, httpLink } from '@trpc/client'
import superjson from 'superjson'

import type { SanitisedText } from '../output'

import type { Backoff, Sleeper } from './backoff'
import { createBackoff, sleep as realSleep } from './backoff'

/** Inferred from the router rather than restated, like everything else on this surface. */
export type ValidationReportInput = MachineRouterInputs['reportValidation']
export type ValidationReportResult = MachineRouterOutputs['reportValidation']

/** One phase result as the executor reports it, with `detail` narrowed to sanitised text. */
export type ValidationPhaseReport = Omit<
  ValidationReportInput['phaseResults'][number],
  'detail'
> & {
  readonly detail?: SanitisedText
}

/** The whole report, with every free-text field narrowed. */
export type ValidationRunReport = Omit<ValidationReportInput, 'phaseResults'> & {
  readonly phaseResults: readonly ValidationPhaseReport[]
}

/**
 * The transport seam.
 *
 * One method, because the surface has one procedure for this caller. Everything above this line is
 * retry policy and everything below it is HTTP, which is what lets the run module be exercised
 * against a fake and never open a socket.
 */
export interface ValidationSurfaceTransport {
  readonly reportValidation: (input: ValidationRunReport) => Promise<ValidationReportResult>
}

export interface HttpValidationTransportOptions {
  /** `machineSurfaceUrl` from the job envelope — already the full mount path. */
  readonly url: string
  /**
   * The validation-scoped credential.
   *
   * A function rather than a value for symmetry with the workflow transport, though nothing renews
   * one: `machine.renewCredential` is a `machineProcedure` and a validation has no workflow to
   * renew against. The window is fifteen minutes and the budget is forty-five, so a `setup.sh` slow
   * enough to outlive its credential fails its report — which is a real limit, stated here rather
   * than hidden, and the reason `VALIDATION_BUDGET_MS` is the bound that actually ends such a run.
   */
  readonly credential: () => string
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The real transport.
 *
 * `httpLink` rather than `httpBatchLink`, for the reason `./client.ts` gives — though with one call
 * there is nothing to batch, so this is consistency rather than a decision.
 */
export const createHttpValidationTransport = (
  options: HttpValidationTransportOptions,
): ValidationSurfaceTransport => {
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
    reportValidation: async (input) =>
      client.reportValidation.mutate(input as ValidationReportInput),
  }
}

/**
 * How many times the one report is attempted before the run gives up on being heard.
 *
 * Eight attempts under the shared schedule is a little over a minute of ceilings — long enough to
 * ride out a deploy of the machine surface, short enough that an instance holding a proof nobody
 * can receive stops burning money rather than retrying into the 45-minute budget. Giving up is not
 * silent: {@link reportValidationResult} rejects, and the run's own exit code says the report never
 * landed, which is the one condition an operator has to read the instance's console for.
 */
export const VALIDATION_REPORT_ATTEMPTS = 8

export interface ValidationSurfaceClientOptions {
  readonly transport: ValidationSurfaceTransport
  readonly attempts?: number
  readonly backoff?: Backoff
  readonly sleep?: Sleeper
  /** Called before each retry, so a run can leave a trace of why it was slow to report. */
  readonly onRetry?: (attempt: number, error: unknown) => void
}

export interface ValidationSurfaceClient {
  readonly reportValidation: (report: ValidationRunReport) => Promise<ValidationReportResult>
}

/**
 * Deliver the one report, retrying under the shared backoff.
 *
 * @param options - The transport, and the retry policy the caller wants.
 */
export const createValidationSurfaceClient = (
  options: ValidationSurfaceClientOptions,
): ValidationSurfaceClient => {
  const attempts = options.attempts ?? VALIDATION_REPORT_ATTEMPTS
  const backoff = options.backoff ?? createBackoff()
  const sleep = options.sleep ?? realSleep

  return {
    reportValidation: async (report) => {
      let lastError: unknown

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await options.transport.reportValidation(report)
        } catch (error) {
          lastError = error
          if (attempt < attempts) {
            options.onRetry?.(attempt, error)
            await sleep(backoff.delayFor(attempt))
          }
        }
      }

      throw new Error(
        `the validation result could not be reported after ${String(attempts)} attempts, so this run proved a bundle and told nobody (FR-147): ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
        { cause: lastError },
      )
    },
  }
}
