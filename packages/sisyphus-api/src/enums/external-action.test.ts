import { describe, expect, it } from 'vitest'

import {
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_RESULTS,
  isExternalActionKind,
  isExternalActionResult,
} from './external-action'

describe('EXTERNAL_ACTION_KINDS', () => {
  it('names every way a run can leave a mark a customer will see (FR-076)', () => {
    expect([...EXTERNAL_ACTION_KINDS]).toStrictEqual([
      'pull_request_opened',
      'comment_posted',
      'ticket_transitioned',
      'branch_pushed',
    ])
  })

  it('guards membership', () => {
    expect(isExternalActionKind('comment_posted')).toBe(true)
    expect(isExternalActionKind('email_sent')).toBe(false)
  })
})

describe('EXTERNAL_ACTION_RESULTS', () => {
  it('carries `pending`, because an action is recorded before it is known to have landed', () => {
    expect([...EXTERNAL_ACTION_RESULTS]).toStrictEqual(['succeeded', 'failed', 'pending'])
    expect(EXTERNAL_ACTION_RESULTS).toContain('pending')
  })

  it('guards membership', () => {
    expect(isExternalActionResult('pending')).toBe(true)
    expect(isExternalActionResult('retrying')).toBe(false)
  })
})
