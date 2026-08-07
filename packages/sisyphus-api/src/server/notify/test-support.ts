import type { WorkflowEventEmitter, WorkflowEventNotification } from './emitter'

/**
 * **Test support for the notification seam.** Not production code, and deliberately not
 * re-exported from `./index.ts` — the same rule `../workflow/test-support.ts` and
 * `../admin/test-database.ts` follow, so a fixture is never one import away from a resolver.
 *
 * Two fakes, because FR-136 and FR-141 are two different assertions:
 *
 * - {@link createRecordingEmitter} answers and keeps what it was asked to send, so a test can say
 *   *which* event was emitted and — through its `onCall` hook — assert what the database looked
 *   like **at the moment of the call**, which is how "emission happens after the commit" is proved
 *   rather than assumed.
 * - {@link createFailingEmitter} rejects every call, which is the only way to prove the FR-141
 *   property: the operation that triggered the notification still succeeds.
 *
 * Both are `WorkflowEventEmitter`s and nothing more. Neither can reach a database, which is the
 * same negative fact the port itself carries.
 */

/** A recording fake, plus what it recorded. */
export interface RecordingEmitter extends WorkflowEventEmitter {
  /** Every notification handed to it, in order. */
  readonly calls: readonly WorkflowEventNotification[]
}

/**
 * An emitter that succeeds and remembers.
 *
 * @param onCall - Run **inside** the call, before it resolves. This is the hook that makes
 *   after-commit testable: whatever it reads, it reads at the instant the notifier was invoked.
 */
export const createRecordingEmitter = (
  onCall?: (notification: WorkflowEventNotification) => Promise<void>,
): RecordingEmitter => {
  const calls: WorkflowEventNotification[] = []

  return {
    calls,
    workflowEvent: async (notification) => {
      calls.push(notification)
      await onCall?.(notification)
      return { delivered: true }
    },
  }
}

/** The message a {@link createFailingEmitter} rejects with. Asserted on, so it is named here. */
export const EMITTER_FAILURE_MESSAGE = 'the notifier is unavailable'

/**
 * An emitter that rejects every call, as a Slack outage or a broken deployment-supplied notifier
 * would.
 *
 * @param calls - Optional sink, so a test can prove the attempt was made as well as survived.
 */
export const createFailingEmitter = (
  calls?: WorkflowEventNotification[],
): WorkflowEventEmitter => ({
  workflowEvent: (notification) => {
    calls?.push(notification)
    return Promise.reject(new Error(EMITTER_FAILURE_MESSAGE))
  },
})
