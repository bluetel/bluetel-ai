import { describe, expect, it } from 'vitest'

import { BOUNDARY_ERROR_CODE, describeBoundaryError, NO_DIGEST } from './boundary-error'

describe('describeBoundaryError', () => {
  it('always carries a code and a next action, because a dead end is not allowed to exist', () => {
    const { content } = describeBoundaryError()

    expect(content.code).toBe(BOUNDARY_ERROR_CODE)
    expect(content.action.length).toBeGreaterThan(0)
  })

  it('reports the same code whatever threw, so the code is worth searching for', () => {
    expect(describeBoundaryError({ digest: 'a' }).content.code).toBe(
      describeBoundaryError({ digest: 'b' }).content.code,
    )
  })

  it('passes the server’s digest through, because it is what ties the screen to the log line', () => {
    expect(describeBoundaryError({ digest: '3751908259' }).digest).toBe('3751908259')
  })

  it('states that no digest was recorded rather than showing a blank', () => {
    expect(describeBoundaryError().digest).toBe(NO_DIGEST)
    expect(describeBoundaryError({}).digest).toBe(NO_DIGEST)
    expect(describeBoundaryError({ digest: '' }).digest).toBe(NO_DIGEST)
  })

  it('never reads the thrown value’s message, so nothing redacted or private is echoed', () => {
    const thrown = Object.assign(new Error('workflow wf_0c8b1 is not yours'), { digest: 'd1' })
    const { content, digest } = describeBoundaryError(thrown)

    expect(content.action).not.toContain('wf_0c8b1')
    expect(content.code).not.toContain('wf_0c8b1')
    expect(digest).toBe('d1')
  })

  it('tells the operator what to do next rather than what went wrong', () => {
    expect(describeBoundaryError().content.action).toMatch(/try the screen again/i)
  })
})
