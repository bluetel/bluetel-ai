/**
 * The notification seam — what this package announces, and the port it announces through.
 *
 * Two modules and no third: `./events.ts` says *which* transitions are notifiable, and
 * `./emitter.ts` is the injected port plus the never-throwing call wrapper FR-141 requires.
 * Nothing here delivers a message, resolves a recipient or writes a `notifications` row — those
 * belong to whichever host wires the port, because the audience and the delivery record live with
 * the messenger and not with the state machine.
 *
 * `./test-support.ts` ships the recording and failing fakes and is deliberately **not** exported
 * from this barrel, the same way `../workflow/test-support.ts` and `../admin/test-database.ts` are
 * kept out of theirs.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export { notificationEventForOutcome, notificationEventForVerdict } from './events'

export { emitWorkflowEvent } from './emitter'
export type {
  WorkflowEventEmission,
  WorkflowEventEmitter,
  WorkflowEventNotification,
} from './emitter'
