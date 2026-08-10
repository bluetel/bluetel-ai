/**
 * Keep-alive — the demand-independent schedule that stops a seat rotting from disuse (FR-035,
 * FR-036, FR-038, SC-009).
 *
 * **This is the mechanism that guarantees liveness, and least-recently-used selection is not.** LRU
 * applies within the group being drawn from, and group attachments are ordered, so a
 * lower-preference group can receive no workflow traffic for months while selection reports itself
 * as spreading load perfectly evenly. `schedule.ts` opens with the argument at length; `select.ts`
 * makes the same point from the other side.
 *
 * Three modules, and the split is along the lines the risk falls on:
 *
 * - `schedule.ts` — who is overdue, claiming, and handing the seat back. The claim is the same
 *   conditional `UPDATE … WHERE state = 'available'` `lease/acquire.ts` uses, so a keep-alive and a
 *   workflow reservation contending for one idle row resolve at the database (FR-038). Zero rows
 *   affected means the other party won; keep-alive yields.
 * - `exercise.ts` — the provider round trip, behind the {@link CredentialExerciser} seam, plus the
 *   `keep_alive_runs` row and the routing of a refusal through `../health/`. What "exercise" means
 *   against a real provider is not determined by the specification and research R1/R2 are explicitly
 *   unmeasured, so it is a seam with a fake: everything above it is testable without a provider, and
 *   a wrong guess costs exactly one module. The default implementation **refuses**, for the reason
 *   `createRefusingPromptRedactor` does.
 * - `exercise-fake.ts` — the recording fake, in the shape every seam in this application ships one.
 *
 * The fake is exported. That is a departure from `../allocate/`, which keeps `pool-fixtures.ts` off
 * its barrel, and the two cases are genuinely different: a fixture that creates and drops databases
 * has no production use, whereas a fake exerciser is how `aws/` already ships every one of its
 * seams — see the note at the top of `aws/index.ts` — and a deployment assembling a context in a
 * test needs one. What is *not* exported is anything that would let a caller exercise a credential
 * without claiming it first.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  claimForKeepAlive,
  credentialsDueForKeepAlive,
  CREDENTIAL_HOLDER_KEEP_ALIVE,
  DEFAULT_KEEP_ALIVE_BATCH,
  KEEP_ALIVE_JOB_NAME,
  releaseKeepAliveClaim,
  sweepKeepAlive,
} from './schedule'
export type {
  DueCredential,
  DueCredentialsOptions,
  KeepAliveAttempt,
  KeepAliveSweepResult,
  ScheduleReader,
  SweepKeepAliveOptions,
} from './schedule'

export {
  createRefusingCredentialExerciser,
  exerciseCredential,
  KEEP_ALIVE_OUTCOMES,
} from './exercise'
export type {
  CredentialExerciser,
  ExerciseCredentialOptions,
  ExerciseOutcome,
  ExerciseRefused,
  ExerciseRequest,
  ExerciseResult,
  ExerciseSucceeded,
  ExercisedCredential,
  KeepAliveOutcome,
  NotExercisable,
} from './exercise'

export { createFakeCredentialExerciser } from './exercise-fake'
export type { FakeCredentialExerciser, FakeCredentialExerciserOptions } from './exercise-fake'
