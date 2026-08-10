import type { CredentialExerciser, ExerciseRequest, ExerciseResult } from './exercise'

/**
 * Recording fake for {@link CredentialExerciser}, in the shape every other seam in this application
 * ships one — see `aws/compute-fake.ts` and the note at the top of `aws/index.ts`.
 *
 * It records **the order** as well as the set, because the two answer different questions. "Was
 * every member of the untouched group exercised" (FR-035) is about the set; "did the sweep stop at
 * its limit" and "was the overdue credential reached before the fresh one" are about the order. A
 * fake that kept only the set would make the second class of assertion impossible to write honestly.
 *
 * The default answer is success, and per-credential answers are supplied by id — which is how a
 * suite says "this one is rate limited and that one's login is broken" without needing two fakes.
 */

export interface FakeCredentialExerciser extends CredentialExerciser {
  /** Every request, in the order it was made. */
  readonly requests: readonly ExerciseRequest[]
  /** Just the credential ids, which is what most assertions are actually about. */
  readonly exercised: () => readonly string[]
  /** Answer differently for one credential from here on. */
  readonly answer: (agentCredentialId: string, result: ExerciseResult) => void
}

export interface FakeCredentialExerciserOptions {
  /** Per-credential answers, by id. Anything absent gets {@link FakeCredentialExerciserOptions.otherwise}. */
  readonly answers?: Readonly<Record<string, ExerciseResult>>
  /** The answer for every credential with no specific one. Defaults to success. */
  readonly otherwise?: ExerciseResult
  /**
   * Credentials the fake throws for, by id.
   *
   * A throw is the platform failing rather than the provider answering — an unwired seam, a
   * Secrets Manager refusal — and the sweep treats the two very differently, so a suite has to be
   * able to produce one.
   */
  readonly throwsFor?: Readonly<Record<string, Error>>
}

export const createFakeCredentialExerciser = (
  options: FakeCredentialExerciserOptions = {},
): FakeCredentialExerciser => {
  const requests: ExerciseRequest[] = []
  const answers = new Map<string, ExerciseResult>(Object.entries(options.answers ?? {}))
  const throwsFor = new Map<string, Error>(Object.entries(options.throwsFor ?? {}))
  const otherwise: ExerciseResult = options.otherwise ?? { outcome: 'succeeded' }

  return {
    requests,

    exercised: () => requests.map((request) => request.agentCredentialId),

    answer: (agentCredentialId, result) => {
      answers.set(agentCredentialId, result)
    },

    exercise: (request) => {
      requests.push(request)

      const thrown = throwsFor.get(request.agentCredentialId)
      if (thrown !== undefined) {
        return Promise.reject(thrown)
      }

      return Promise.resolve(answers.get(request.agentCredentialId) ?? otherwise)
    },
  }
}
