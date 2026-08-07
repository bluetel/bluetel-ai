import { describe, expect, it } from 'vitest'

import type { WorkflowEventNotification } from './emitter'
import {
  createFailingEmitter,
  createRecordingEmitter,
  EMITTER_FAILURE_MESSAGE,
} from './test-support'

const notification: WorkflowEventNotification = {
  workflowId: '00000000-0000-7000-8000-000000000002',
  event: 'review_iteration_failed',
}

/**
 * The fakes, asserted on directly.
 *
 * A fixture that lies is worse than no fixture: a recording emitter that quietly dropped a call
 * would make an after-commit test pass by never running its hook, and a failing emitter that
 * resolved would make the FR-141 proof vacuous. Both properties are cheap to state, so they are
 * stated.
 */
describe('createRecordingEmitter', () => {
  it('records every call in order', async () => {
    const emitter = createRecordingEmitter()

    await emitter.workflowEvent(notification)
    await emitter.workflowEvent({ ...notification, event: 'workflow_capped' })

    expect(emitter.calls.map((call) => call.event)).toStrictEqual([
      'review_iteration_failed',
      'workflow_capped',
    ])
  })

  it('runs its hook inside the call, which is what makes after-commit observable', async () => {
    const seen: string[] = []
    const emitter = createRecordingEmitter(async (call) => {
      seen.push(call.workflowId)
      await Promise.resolve()
    })

    await emitter.workflowEvent(notification)

    expect(seen).toStrictEqual([notification.workflowId])
  })

  it('propagates a hook failure, so a failed assertion inside it is not swallowed here', async () => {
    const emitter = createRecordingEmitter(() => Promise.reject(new Error('assertion')))

    await expect(emitter.workflowEvent(notification)).rejects.toThrow('assertion')
  })
})

describe('createFailingEmitter', () => {
  it('rejects every call', async () => {
    await expect(createFailingEmitter().workflowEvent(notification)).rejects.toThrow(
      EMITTER_FAILURE_MESSAGE,
    )
  })

  it('still records the attempt when given a sink', async () => {
    const attempts: WorkflowEventNotification[] = []

    await expect(createFailingEmitter(attempts).workflowEvent(notification)).rejects.toThrow()

    expect(attempts).toStrictEqual([notification])
  })
})
