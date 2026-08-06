import { describe, expect, it } from 'vitest'

import {
  notificationEventInput,
  setNotificationPreferenceInput,
  watchWorkflowInput,
} from './notification'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

describe('notificationEventInput', () => {
  it('refuses an event that will never fire — a preference cannot silence one', () => {
    expect(notificationEventInput.safeParse('workflow_succeeded').success).toBe(true)
    expect(notificationEventInput.safeParse('workflow_daydreamed').success).toBe(false)
  })
})

describe('setNotificationPreferenceInput', () => {
  it('requires `enabled` rather than defaulting it — the default is not silence (FR-138)', () => {
    // Absence of a preference row means enabled. Defaulting the field would let a form that
    // forgot to send it quietly mute an event instead of failing validation.
    expect(setNotificationPreferenceInput.safeParse({ event: 'workflow_failed' }).success).toBe(
      false,
    )
    expect(
      setNotificationPreferenceInput.parse({ event: 'workflow_failed', enabled: false }),
    ).toStrictEqual({ event: 'workflow_failed', enabled: false })
  })
})

describe('watchWorkflowInput', () => {
  it('takes only a workflow id — watching is scoped like a read (FR-190)', () => {
    expect(Object.keys(watchWorkflowInput.shape)).toStrictEqual(['workflowId'])
    expect(watchWorkflowInput.parse({ workflowId: ID })).toStrictEqual({ workflowId: ID })
  })
})
