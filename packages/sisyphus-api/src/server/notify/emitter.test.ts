import { describe, expect, it } from 'vitest'

import type { WorkflowEventEmitter, WorkflowEventNotification } from './emitter'
import { emitWorkflowEvent } from './emitter'
import {
  createFailingEmitter,
  createRecordingEmitter,
  EMITTER_FAILURE_MESSAGE,
} from './test-support'

const notification: WorkflowEventNotification = {
  workflowId: '00000000-0000-7000-8000-000000000001',
  event: 'workflow_succeeded',
}

/**
 * The port and its never-throwing wrapper (FR-136, FR-141).
 *
 * FR-141 is the whole of this file: *a delivery failure MUST NOT alter the workflow's own state or
 * outcome*. The database-backed half of that proof lives in `../machine/reporting.test.ts`, where a
 * real transaction is shown to survive a rejecting notifier; here the property is asserted about
 * the wrapper itself, without a database, so it cannot be weakened by an edit that nobody runs
 * Postgres against.
 */
describe('emitWorkflowEvent', () => {
  it('hands the notification to a wired notifier', async () => {
    const emitter = createRecordingEmitter()

    const emission = await emitWorkflowEvent(emitter, notification)

    expect(emission.emitted).toBe(true)
    expect(emitter.calls).toStrictEqual([notification])
  })

  it('is a silent no-op when the deployment has wired no notifier', async () => {
    // Absent is not an error. A platform whose Slack app is not installed yet must still be able
    // to finish a workflow — contrast `admin/reachability.ts`, whose absent probe refuses.
    const emission = await emitWorkflowEvent(undefined, notification)

    expect(emission).toStrictEqual({ emitted: false })
  })

  it('never rejects when the notifier does (FR-141)', async () => {
    const attempts: WorkflowEventNotification[] = []

    const emission = await emitWorkflowEvent(createFailingEmitter(attempts), notification)

    expect(emission.emitted).toBe(false)
    // The attempt was made, so this is a swallowed failure and not a skipped call.
    expect(attempts).toStrictEqual([notification])
  })

  it('keeps what the notifier threw, so a host can log rather than guess', async () => {
    const emission = await emitWorkflowEvent(createFailingEmitter(), notification)

    expect(emission.failure).toBeInstanceOf(Error)
    expect((emission.failure as Error).message).toBe(EMITTER_FAILURE_MESSAGE)
  })

  it('survives a notifier that throws synchronously rather than rejecting', async () => {
    // A deployment may supply its own implementation, and an interface cannot require that its
    // failures arrive as rejections. Both shapes have to be equally harmless.
    const thrower: WorkflowEventEmitter = {
      workflowEvent: () => {
        throw new Error('synchronous')
      },
    }

    await expect(emitWorkflowEvent(thrower, notification)).resolves.toStrictEqual({
      emitted: false,
      failure: expect.any(Error) as Error,
    })
  })

  it('does not read what the notifier answered with', async () => {
    // The return is a fact about delivery, and delivery is not this package's business. Declaring
    // it `unknown` is what lets the control plane's `WorkflowNotifier` — which answers with a
    // delivery record — satisfy this port with no adapter.
    const chatty: WorkflowEventEmitter = {
      workflowEvent: () => Promise.resolve({ deliveries: [{ outcome: 'failed' }] }),
    }

    await expect(emitWorkflowEvent(chatty, notification)).resolves.toStrictEqual({ emitted: true })
  })
})
