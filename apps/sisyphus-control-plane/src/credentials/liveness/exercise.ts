import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import { agentCredentials, keepAliveRuns } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'

import type { CredentialAlerter, ProviderResponse } from '../health'
import { applyHealthVerdict, classifyProviderResponse } from '../health'

/**
 * Exercising one credential — the provider round trip, the row it writes, and the seam that keeps
 * the rest of this feature testable without a provider (FR-035, FR-037, research R2).
 *
 * ## What "exercise" means, and what has been assumed
 *
 * The specification does not say, and it deliberately cannot: research R2 records that the idle
 * window a credential survives is **unmeasured**, and R1 records that the invalidation behaviour of
 * a rotated credential is unmeasured too. What is known is the shape of the answer — some minimal,
 * cheap, authenticated call to the provider, made often enough that the login never lapses — and
 * that the shape of the *response* is what matters, because that is what `../health/classify.ts`
 * turns into a verdict.
 *
 * So the provider interaction is a **seam**, {@link CredentialExerciser}, and everything this
 * directory actually asserts — the schedule, the FR-038 claim, the release, the keep-alive history,
 * the routing of a failure through classification — is asserted against a fake. That is the same
 * arrangement every external system in this application already has (`ComputeProvisioner`,
 * `ObjectStore`, `ScheduleRegistry`, `SecretReader`), and it is chosen here for one specific
 * reason: **a wrong guess about what to call costs one module**. If the cheapest liveness call
 * turns out to be a different endpoint, or a token refresh rather than a request, the implementation
 * behind this interface changes and the claiming, scheduling and classification above it do not.
 *
 * The assumptions the interface encodes, stated so they can be checked rather than discovered:
 *
 * 1. **An exercise either works or comes back with a response that can be classified.** There is no
 *    third outcome that means something about the credential. A transport failure with no response
 *    at all is still a {@link ExerciseRefused} carrying an empty {@link ProviderResponse}, which
 *    classifies as ambiguous and therefore as `cooling_off` — the safe direction.
 * 2. **The exerciser reads the material itself, from the identifier it is handed.** This module
 *    passes `secret_id` — a *name* — and never material, so no credential ever enters the control
 *    plane's job path, its logs or its return values (FR-011, SC-014). An implementation fetches
 *    from Secrets Manager behind the seam.
 * 3. **A successful exercise proves the login works and nothing more.** It is not a rotation, it
 *    does not persist anything, and it does not raise the fence.
 *
 * ## Why a provider limit still updates `last_exercised_at`
 *
 * This is the non-obvious line in the file. A `429` means the provider **answered**, which is
 * exactly what a keep-alive was checking — FR-037 says so directly: "the credential is alive, which
 * is what keep-alive was checking". So a limit refreshes the liveness clock even though the
 * exercise did not succeed. An authentication failure does not: the login is broken, and recording
 * it as recently proven would keep the scheduler from looking at it again.
 *
 * ## Why `last_used_at` is left alone
 *
 * `last_exercised_at` and `last_used_at` are two columns because they answer two questions: the
 * first is *is this login still good*, the second is *whose turn is it* (FR-034). Keep-alive
 * answers the first and has no opinion on the second, and writing it into `last_used_at` would
 * rotate the pool's preference order on a timer rather than on demand — a keep-alive sweep would
 * quietly reshuffle which seat the next workflow gets.
 */

/** What the exerciser is told about the credential. A name, never material — see the module note. */
export interface ExerciseRequest {
  readonly agentCredentialId: string
  /** For the implementation's own logging, and for an error message that names something human. */
  readonly credentialName: string
  /** The Secrets Manager identifier the material is filed under (FR-011, research R8). */
  readonly secretId: string
}

/** The provider accepted the credential. */
export interface ExerciseSucceeded {
  readonly outcome: 'succeeded'
}

/**
 * The provider refused, or could not be reached.
 *
 * The response travels back **unclassified**: deciding what it means is `../health/classify.ts`'s
 * single job, and an exerciser that returned a verdict would be a second classifier living wherever
 * somebody wired the seam.
 */
export interface ExerciseRefused {
  readonly outcome: 'refused'
  readonly response: ProviderResponse
}

export type ExerciseResult = ExerciseRefused | ExerciseSucceeded

/**
 * The provider round trip, as a port.
 *
 * One method, because there is one question: does this login still work. Anything wider would be a
 * general-purpose provider client living in the control plane, which is precisely what the agent
 * adapter boundary exists to prevent (FR-003).
 */
export interface CredentialExerciser {
  readonly exercise: (request: ExerciseRequest) => Promise<ExerciseResult>
}

/**
 * The default seam: one that refuses, loudly.
 *
 * The same choice `createRefusingPromptRedactor` makes in `jobs/prompt-redact.ts`, and for the same
 * reason. No implementation of the provider round trip ships yet, and the two ways to have no
 * implementation are very different: a stub that reports success would mark every credential in the
 * pool as freshly exercised without touching a provider, which is SC-009 quietly and permanently
 * defeated — a pool that reports itself healthy right up until every login has expired. A refusal
 * fails the keep-alive job on its first fire, where somebody sees it.
 *
 * It **throws** rather than returning {@link ExerciseRefused}, and that distinction is load-bearing:
 * a refusal is a provider's answer and gets classified, whereas this is the platform not being
 * wired, and classifying it would move every credential in the pool to `cooling_off` for a
 * configuration fault.
 */
export const createRefusingCredentialExerciser = (): CredentialExerciser => ({
  exercise: (request) =>
    Promise.reject(
      new Error(
        `No credential exerciser is wired, so agent credential ${request.credentialName} cannot be kept alive. This deployment must supply a CredentialExerciser; failing loudly is deliberate, because a keep-alive that reported success without reaching a provider would mark every seat in the pool as freshly proven and let them all expire silently (FR-035, SC-009).`,
      ),
    ),
})

/** The three outcomes `keep_alive_runs.outcome` records. Text in the column; a tuple here. */
export const KEEP_ALIVE_OUTCOMES = ['succeeded', 'cooling_off', 'failed'] as const

export type KeepAliveOutcome = (typeof KEEP_ALIVE_OUTCOMES)[number]

export interface ExerciseCredentialOptions {
  readonly db: SisyphusDatabase
  readonly exerciser: CredentialExerciser
  readonly agentCredentialId: string
  /** Passed through to `applyHealthVerdict`, which consults it only on `unhealthy` (FR-037). */
  readonly alerter?: CredentialAlerter
  readonly now?: Date
}

/** One credential exercised, and what it proved. */
export interface ExercisedCredential {
  readonly outcome: KeepAliveOutcome
  readonly agentCredentialId: string
  /** The row written to `keep_alive_runs`, so a caller can report the history it just added to. */
  readonly keepAliveRunId: string
  /** Where the credential ended up, when the exercise moved it. `undefined` on success. */
  readonly credentialState: 'cooling_off' | 'unhealthy' | undefined
  /** True when an administrator was told, which happens on exactly one branch. */
  readonly alerted: boolean
}

/**
 * The credential could not be exercised at all, and no history was written.
 *
 * The only case is FR-008's: `secret_id` is null, so there is nowhere to fetch material from. A
 * `keep_alive_runs` row saying `failed` would be a lie about the login — nothing was tried — and it
 * would move a credential to `unhealthy` for a state it has legitimately been in since registration.
 */
export interface NotExercisable {
  readonly outcome: 'not_exercisable'
  readonly agentCredentialId: string
  readonly reason: string
}

export type ExerciseOutcome = ExercisedCredential | NotExercisable

/** See `allocate/select.ts`: `noUncheckedIndexedAccess` is off, so indexing needs an honest type. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Prove one credential still works, and write down what happened.
 *
 * The caller has already claimed the row — see `schedule.ts`, and FR-038 — so this does not compete
 * for it and does not release it. It exercises, records, and routes a refusal through
 * classification; handing the seat back is the claimant's job precisely because it must happen
 * whatever this returns, including when it throws.
 *
 * @param options - The handle, the seam, the credential, and optionally an alerter and a clock.
 * @returns What the exercise proved, or {@link NotExercisable}.
 * @throws Whatever the exerciser throws. A throw is the platform failing — an unwired seam, a
 *   Secrets Manager refusal — and not a provider's answer, so it must not be classified into a
 *   verdict about the credential. The sweep above lets it end the pass.
 */
export const exerciseCredential = async (
  options: ExerciseCredentialOptions,
): Promise<ExerciseOutcome> => {
  const { agentCredentialId, db, exerciser } = options
  const now = options.now ?? new Date()

  const credential = firstRow(
    await db
      .select({
        name: agentCredentials.name,
        secretId: agentCredentials.secretId,
      })
      .from(agentCredentials)
      .where(eq(agentCredentials.id, agentCredentialId)),
  )

  if (credential === undefined) {
    return {
      outcome: 'not_exercisable',
      agentCredentialId,
      reason: 'the credential no longer exists',
    }
  }

  if (credential.secretId === null) {
    return {
      outcome: 'not_exercisable',
      agentCredentialId,
      reason:
        'the credential has no stored material to exercise, so there is nothing to prove (FR-008)',
    }
  }

  const result = await exerciser.exercise({
    agentCredentialId,
    credentialName: credential.name,
    secretId: credential.secretId,
  })

  const verdict =
    result.outcome === 'succeeded' ? undefined : classifyProviderResponse(result.response, now)

  // `cooling_off` counts as proof of life: the provider answered, which is what was being checked
  // (FR-037). An authentication failure does not, so the scheduler keeps seeing it as overdue.
  const provedAlive = verdict === undefined || verdict.state === 'cooling_off'

  const outcome: KeepAliveOutcome =
    verdict === undefined ? 'succeeded' : verdict.state === 'cooling_off' ? 'cooling_off' : 'failed'

  const recorded = await db.transaction(async (tx) => {
    if (provedAlive) {
      await tx
        .update(agentCredentials)
        .set({ lastExercisedAt: now })
        .where(eq(agentCredentials.id, agentCredentialId))
    }

    return firstRow(
      await tx
        .insert(keepAliveRuns)
        .values({
          agentCredentialId,
          ranAt: now,
          outcome,
          // The classification's sentence, which is composed and never quoted from the provider's
          // body — see `classify.ts`. The column carries no material for the same reason no column
          // in `credential.ts` does.
          detail: verdict?.reason ?? null,
        })
        .returning({ id: keepAliveRuns.id }),
    )
  })

  if (recorded === undefined) {
    throw new Error(
      `Recording the keep-alive exercise for agent credential ${agentCredentialId} returned no row. The history this table accumulates is what makes SISYPHUS_KEEPALIVE_IDLE_HOURS tunable from evidence rather than from the assumption in research R2, so an exercise that ran without being recorded is worse than one that did not run.`,
    )
  }

  if (verdict === undefined) {
    return {
      outcome,
      agentCredentialId,
      keepAliveRunId: recorded.id,
      credentialState: undefined,
      alerted: false,
    }
  }

  // Applied after the history row, and in its own transaction: the exercise happened whatever the
  // transition then decides, and the two are separately true.
  const transition = await applyHealthVerdict({
    db,
    agentCredentialId,
    verdict,
    alerter: options.alerter,
    now,
  })

  return {
    outcome,
    agentCredentialId,
    keepAliveRunId: recorded.id,
    credentialState: verdict.state,
    alerted: transition.outcome === 'changed' && transition.alerted,
  }
}
