import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * **Saying that a run is waiting on storage (T184, FR-082).**
 *
 * FR-082 requires that a run which cannot write its snapshot **parks** — holds the agent at the
 * turn boundary it reached, spends nothing further, keeps heartbeating, and retries — and that
 * "the panel says it is waiting on storage rather than showing a stalled pause". That last clause
 * was the one nothing in this app implemented: the phrase appeared in three executor comments and
 * nowhere in `src/`.
 *
 * ## Rendering the `parked_resumable` chip is not saying this
 *
 * The panel does present `parked_resumable`, and its supervision readout reads *"The snapshot is
 * stored and the compute has been released."* That is the opposite situation. A storage park is a
 * **live** run whose snapshot did **not** land and whose instance is still held. A screen that
 * offered the parked chip for it would tell an operator their work was safely captured at the
 * precise moment it was not, and would offer them Resume for a run that has not stopped.
 *
 * So this is a separate readout on a separate axis, and the run's own state chip is left alone —
 * during a park the run really is `running`, and the heartbeat really is still reporting it.
 *
 * ## What the copy has to contain
 *
 * Three things, because each answers a question an operator would otherwise have to ask somebody:
 *
 * - **that it is waiting on storage**, not hung — the distinction the requirement is about;
 * - **that it is being retried, and how far through the budget it is** — "retrying" alone does not
 *   tell anyone whether to wait or to go and look at the bucket;
 * - **that nothing is being spent** — a run that appears to be running for two minutes doing
 *   nothing is otherwise a reason to kill it, and killing it is what loses the work.
 */

/** The park as `workflow.byId` returns it. */
export type StorageParkResult = NonNullable<RouterOutputs['workflow']['byId']['storagePark']>

/** What the detail view puts on screen for a park. */
export interface StorageParkReadout {
  /** True while the run is still holding. Drives whether the copy is present or past tense. */
  readonly waiting: boolean
  /** The short line, for a heading or a chip. Sentence case. */
  readonly headline: string
  /** The paragraph that says what is happening and what it means. */
  readonly explanation: string
  /** What storage said, when it said anything. Rendered as its own line, never inlined. */
  readonly cause: string | null
}

const MILLISECONDS_PER_SECOND = 1000

/**
 * A retry delay, in whole seconds and never `0s`.
 *
 * Rounded up rather than down: "next in 0s" on a 400ms wait reads as "it should have happened
 * already", which invites exactly the interpretation — that the thing is stuck — that this whole
 * readout exists to prevent.
 */
export const formatRetryDelay = (milliseconds: number): string =>
  `${String(Math.max(1, Math.ceil(milliseconds / MILLISECONDS_PER_SECOND)))}s`

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/**
 * Turn a recorded park into what the panel says about it.
 *
 * @param park - The park as `workflow.byId` returned it, or null when the run never parked.
 *   `undefined` is accepted as well: a panel served by an API that predates the field would
 *   otherwise throw here, and a missing park has to read as "no park", never as a broken card.
 * @returns The readout, or `undefined` when there is nothing to say.
 */
export const toStorageParkReadout = (
  park: StorageParkResult | null | undefined,
): StorageParkReadout | undefined => {
  if (park === null || park === undefined) {
    return undefined
  }

  const cause = park.detail === null || park.detail === '' ? null : park.detail

  if (!park.waiting) {
    // Past tense, and deliberately silent about how it ended. The run may have recovered, or the
    // budget may have run out and the outcome reason in the same card may already be naming this
    // boundary. Guessing between them here would put a second, possibly contradictory account of
    // the ending a few lines above the real one.
    return {
      waiting: false,
      headline: 'Waited on storage earlier in this run',
      explanation:
        `The ${park.boundary} snapshot could not be written straight away, so the run held at ` +
        `that boundary and retried; ${plural(park.attempt, 'attempt')} failed. A gap in the log ` +
        'around that point is the wait.',
      cause,
    }
  }

  return {
    waiting: true,
    headline: 'Waiting on storage',
    explanation:
      `This run has reached a ${park.boundary} boundary and cannot write its snapshot, so it is ` +
      'holding there rather than carrying on unsnapshotted. It has not stalled and it has not ' +
      `failed: the write is being retried — attempt ${String(park.attempt)} of ` +
      `${String(park.maxAttempts)}, the next in ${formatRetryDelay(park.nextDelayMs)} — and no ` +
      'turns and no spend are going on while it waits.',
    cause,
  }
}
