/**
 * **Turning a declared budget term into a bound that actually fires (T185, FR-205, SC-003).**
 *
 * `./budget.ts` states what each step of the pause path is allowed to cost. Until this module
 * existed, four of its five terms were passed as a timeout to no operation at all: the arithmetic
 * added up, the constants were asserted against each other, and a `pullPendingCommands` that took
 * forty seconds would have sailed past every one of them. FR-205 names that shape directly — a
 * budget expressed as constants is a statement of intent, and **each term must additionally be
 * enforced as a real timeout at the operation it bounds**.
 *
 * ## What a deadline does, and the one thing it cannot do
 *
 * It races the operation against a timer and rejects with {@link DeadlineExceededError} if the
 * timer wins. It does **not** cancel the operation: none of the four bounded operations takes an
 * `AbortSignal`, and inventing one for the sake of this module would push a cancellation contract
 * into a tRPC client and an S3 writer that neither of them honours. So the honest description is
 * *abandoned, not aborted* — the caller stops waiting and stops depending on the result, and the
 * request finishes into a void.
 *
 * That is safe for every operation this bounds, and it is worth saying why rather than assuming it:
 *
 * - `pullPendingCommands` is a read. An abandoned one costs a round trip.
 * - `acknowledgeCommand` is idempotent on `acknowledged_at is null`, so the retry the next cycle
 *   makes is the same call the abandoned one was.
 * - the snapshot capture is retried by `session/park.ts`, whose whole design is that the operation
 *   is safe to repeat.
 *
 * An operation for which abandonment is *not* safe must not be bounded this way, and none is.
 *
 * ## Why the error is a class rather than a message
 *
 * The caller has to be able to report which term was blown, not scrape it out of a string: a pause
 * that missed SC-003 because the machine surface was slow and one that missed it because the agent
 * would not reach a turn boundary are different problems with different fixes, and the panel shows
 * whichever reason the executor hands it.
 */

/** A budget term that was exceeded, naming the operation and the term it belongs to. */
export class DeadlineExceededError extends Error {
  /** What was being waited on, in words a panel can show. */
  readonly operation: string
  /** The term's value, so a report can say what was exceeded rather than only that something was. */
  readonly budgetMs: number

  constructor(options: { readonly operation: string; readonly budgetMs: number }) {
    super(
      `${options.operation} did not finish inside its ${String(options.budgetMs)}ms budget, so it ` +
        'was abandoned rather than allowed to run the pause past SC-003’s ten seconds',
    )
    this.name = 'DeadlineExceededError'
    this.operation = options.operation
    this.budgetMs = options.budgetMs
  }
}

/** Whether a thrown value is a blown budget term rather than an ordinary failure. */
export const isDeadlineExceeded = (error: unknown): error is DeadlineExceededError =>
  error instanceof DeadlineExceededError

export interface DeadlineOptions {
  /** Named in the error. Use the operation, not the constant: "pulling supervision commands". */
  readonly operation: string
  /**
   * The term in force. A non-positive budget means unbounded, which is how a caller expresses
   * "this term does not apply here" without a second code path.
   */
  readonly budgetMs: number
}

/**
 * Run `operation`, rejecting if it has not settled within the term.
 *
 * @param operation - The work to bound. Called once, immediately.
 * @param options - The term and what to call it. See {@link DeadlineOptions}.
 * @returns Whatever the operation resolved with, if it resolved in time.
 * @throws DeadlineExceededError when the term elapses first. Whatever the operation throws
 *   otherwise, unchanged — a deadline must not disguise a real failure as a slow one.
 */
export const withDeadline = async <TResult>(
  operation: () => Promise<TResult>,
  options: DeadlineOptions,
): Promise<TResult> => {
  if (options.budgetMs <= 0) {
    return operation()
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DeadlineExceededError(options))
        }, options.budgetMs)
        // The deadline must not be the reason a finished process stays alive.
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
