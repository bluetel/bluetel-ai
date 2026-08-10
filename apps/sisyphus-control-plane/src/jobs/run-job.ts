import type { AgentCredential } from '@bluetel-ai/sisyphus-api/db'

/**
 * Uniform invocation wrapper for control-plane jobs.
 *
 * Every job in this app is invoked internally — in-process or by EventBridge
 * Scheduler — never over an inbound network surface (FR-035). `runJob` gives
 * those invocations one shape: a job either succeeds with a value or fails with
 * a captured error, and either way the caller gets the elapsed duration for the
 * run so scheduled invocations can be logged and alerted on consistently.
 *
 * It is also where the rule about **what a run does when its own agent credential changes state
 * underneath it** lives — see {@link runWaitsForCredential} below, and the long note on it. That
 * rule is a decision about how a job ends, which is what this module is about, and it has to be one
 * answer rather than one per job: the two ends of it (wait, or fail naming the credential) are the
 * difference between SC-020's "zero runs failed for a limit that later cleared" and a pool that
 * quietly loses runs to provider throttling.
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

/**
 * The state of a run's own agent credential that means **wait**, rather than **fail** (003/FR-077,
 * FR-023, SC-020).
 *
 * There is exactly one, and naming it rather than writing the literal at each call site is the
 * point: the states a run may be failed for and the states it must sit out are two lists that must
 * never overlap, and the way that goes wrong is somebody adding a comparison in a job.
 */
export const CREDENTIAL_STATE_A_RUN_WAITS_OUT = 'cooling_off'

/**
 * Whether a run must **wait out** its own credential's current state rather than be failed for it.
 *
 * ## Why waiting is the only correct behaviour, rather than the kind one
 *
 * FR-023 forbids moving a workflow to a different agent credential **under any circumstance** — not
 * across a pause, a park, an environment rebuild, or a credential failure. So when a run's own
 * credential hits a provider usage or rate limit mid-run there are exactly two things the platform
 * could do, and substituting another seat is not one of them: fail the run, or wait.
 *
 * Failing it would be wrong on the facts. `cooling_off` means the provider answered and is
 * throttling — the credential is alive, the login works, the limit clears by itself on the FR-076
 * sweep, usually in minutes. A run failed for that is a run failed for something that had already
 * fixed itself by the time anybody looked, and SC-020 measures exactly this: "zero runs failed for a
 * limit that later cleared". It would also be expensive in a way that compounds — the run has an
 * instance, a working tree and a conversation, all of which are thrown away and rebuilt for a wait
 * that would have been shorter than the rebuild.
 *
 * So the run waits, and **keeps its lease while it waits**. That is not incidental: releasing the
 * seat would put it back in the pool for some other workflow to take, and then FR-023 could not be
 * honoured when the limit cleared — the run would have nothing to come back to. The lease is the
 * run's for its whole life (FR-018, FR-019), a health transition does not touch it (see
 * `credentials/health/transition.ts`), and this predicate is what stops a job deciding otherwise.
 *
 * The wait is visible to the run's owner in the workflow view as a provider limit rather than as a
 * stall (FR-077), and it raises **no** notification — FR-079 keeps waiting, cooling off and parking
 * off the notification path entirely, because they resolve in seconds without anybody needing to
 * act.
 *
 * ## What this deliberately does not answer
 *
 * Which states a run is **failed** for. `unhealthy` is the case, and it is the opposite decision:
 * the login is broken, no amount of waiting repairs it, and FR-033 has the run fail **naming the
 * credential** rather than silently retrying on another seat. That is {@link runFailsForCredential}
 * below, and the two are read together through {@link credentialVerdictFor}. Answering it here as a
 * negation — "anything not cooling off proceeds" — would quietly claim that a broken credential is
 * fine to carry on with, which is the more expensive of the two wrong answers.
 *
 * @param state - The state of the credential the run holds. Taken from the column rather than
 *   restated, so a member added to `credential_state` is a compile-time visit to this function.
 * @returns `true` only for the one state a run sits out.
 */
export const runWaitsForCredential = (state: AgentCredential['state']): boolean =>
  state === CREDENTIAL_STATE_A_RUN_WAITS_OUT

/**
 * The state of a run's own agent credential that means **fail**, rather than wait (003/FR-023,
 * FR-033, SC-010).
 *
 * Exactly one, named for the same reason its sibling is: the states a run waits out and the states
 * it is failed for are two lists that must never overlap, and the way that goes wrong is somebody
 * writing a comparison inside a job.
 */
export const CREDENTIAL_STATE_A_RUN_FAILS_ON = 'unhealthy'

/**
 * Whether a run must be **failed** for its own credential's current state.
 *
 * ## Why failing is the only correct behaviour, and why substituting is not on the list
 *
 * `unhealthy` means the stored material has been detected as no longer usable (FR-033): the login
 * is broken, the provider is not throttling, and nothing about waiting repairs it — a credential
 * only leaves this state through an administrator re-logging it in (FR-010, FR-072), which is
 * minutes of somebody's attention rather than the seconds `cooling_off` costs. So the two things
 * this platform could do are fail the run or move it to another seat, and **FR-023 forbids the
 * second under any circumstance** — not across a pause, a park, an environment rebuild, or a
 * credential failure. It says so about credential failure explicitly, because that is the case
 * where substituting looks most like kindness.
 *
 * It is not kindness. The run is a session authenticated as one identity, with a working tree, a
 * conversation and — the part that decides it — external side effects already attributed to that
 * identity. Continuing the same run as somebody else would make its own history a fiction, and it
 * would do so silently, which is how a pool ends up with two runs' work filed under one seat.
 *
 * So the run fails, **naming the credential** ({@link credentialFailureReason}), and the seat is
 * left where it is: a health transition does not touch the lease (see
 * `credentials/health/transition.ts`), and the release happens when the run reaches its terminal
 * state like any other. A failing run that also handed its seat back early would be a run that had
 * been quietly moved off it.
 *
 * ## There is no retry, silent or otherwise
 *
 * Nothing here re-selects, and nothing downstream of it may: the reason carries a remedy for a
 * *person* — an administrator re-logs the credential in, the owner relaunches — because the only
 * thing that makes this run's work possible again is the same credential coming back. A retry on
 * another seat would be the substitution FR-023 forbids, arrived at one attempt at a time.
 *
 * @param state - The state of the credential the run holds, from the column rather than restated.
 * @returns `true` only for the one state a run is failed for.
 */
export const runFailsForCredential = (state: AgentCredential['state']): boolean =>
  state === CREDENTIAL_STATE_A_RUN_FAILS_ON

/** What a run does about its own credential's current state. Exactly three answers, and no fourth. */
export const CREDENTIAL_VERDICTS = ['proceed', 'wait', 'fail'] as const

export type CredentialVerdict = (typeof CREDENTIAL_VERDICTS)[number]

/**
 * The one place the two predicates are read together.
 *
 * Written as a composition of {@link runWaitsForCredential} and {@link runFailsForCredential}
 * rather than as a fresh `switch`, so the wait rule has one definition and the exclusivity between
 * the two lists is structural: `wait` is answered first and `fail` only from what is left, so no
 * state can be both however the enum grows.
 *
 * **`proceed` is the default, and that is safe only because the two positive lists are explicit.**
 * A `held` credential is the ordinary case and an `available` one is what a keep-alive exercise
 * leaves behind; both mean the run carries on. A state added to `credential_state` later lands here
 * as `proceed`, which is the same direction of default the selection predicate takes in the
 * opposite sense — selection names the one state it accepts, and this names the two it acts on.
 *
 * @param state - The state of the credential the run holds.
 */
export const credentialVerdictFor = (state: AgentCredential['state']): CredentialVerdict => {
  if (runWaitsForCredential(state)) return 'wait'
  return runFailsForCredential(state) ? 'fail' : 'proceed'
}

/**
 * What is recorded on a run failed for its credential (FR-023, FR-033).
 *
 * Rendered to the run's owner verbatim, so it has to answer the three questions they will actually
 * have, in the order they will have them:
 *
 * 1. **Which credential.** FR-033 says "naming the credential" and this is that word. A run that
 *    ended for "a credential problem" sends its owner to an administrator who then has to work out
 *    which of the pool's seats it was.
 * 2. **Why it was not simply moved.** Because it is the obvious question, and because the answer is
 *    a platform rule (FR-023) rather than a shortage — an owner told only "no credential" will ask
 *    for more capacity, which would not have helped.
 * 3. **What makes it runnable again.** An administrator re-logs the seat in; the run is relaunched.
 *    Not "retry", which would suggest that pressing the button again might land on a working seat.
 *
 * The provider's own words are quoted when there are any, because `last_failure_reason` is very
 * often the only evidence of what actually broke — and it is a **reason**, never material: every
 * writer of that column passes a fixed sentence or a store's error text, and `credentials.test.ts`
 * scans the rendered value.
 *
 * @param credential - The seat the run held: its name, and whatever it last recorded about itself.
 */
export const credentialFailureReason = (credential: {
  readonly name: string
  readonly lastFailureReason: string | null
}): string =>
  [
    `The agent credential ${credential.name} was found to be unusable, so this run has been failed.`,
    credential.lastFailureReason === null
      ? undefined
      : `The credential recorded: ${credential.lastFailureReason}`,
    'The run was not moved to another agent credential and was not retried on one: a workflow keeps the single identity it was admitted with for its whole life. Once an administrator has logged this credential back in, relaunch the run.',
  ]
    .filter((part) => part !== undefined)
    .join(' ')

/**
 * The failure a job raises when the run's own credential has gone `unhealthy`.
 *
 * An `Error` rather than a returned outcome, so it travels the path {@link runJob} already has for
 * everything else that ends a job — captured, timed and reported as `{ ok: false, error }`. The
 * message is {@link credentialFailureReason} unchanged, because the sentence the owner reads on the
 * run and the sentence in the operator's log should not be two sentences that can drift.
 *
 * @param credential - The seat the run held.
 */
export const credentialFailedError = (credential: {
  readonly name: string
  readonly lastFailureReason: string | null
}): Error => {
  const error = new Error(credentialFailureReason(credential))
  error.name = 'AgentCredentialUnusable'
  return error
}
