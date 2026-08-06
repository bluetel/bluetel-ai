import type { AuthorisationDenial } from '@bluetel-ai/sisyphus-api/server'
import { describe, expect, it, vi } from 'vitest'

import {
  createDenialRecorder,
  createLoggingDenialWriter,
  formatDenial,
  recordDenial,
} from './record-denial'

const NOT_ADMIN: AuthorisationDenial = {
  reason: 'not_admin',
  userId: '0199a1f4-0000-7000-8000-000000000003',
  path: 'admin.users.setRole',
}

describe('formatDenial', () => {
  it('renders the fields that are present, in a fixed order', () => {
    expect(formatDenial(NOT_ADMIN)).toBe(
      'reason=not_admin path=admin.users.setRole userId=0199a1f4-0000-7000-8000-000000000003',
    )
  })

  it('omits absent fields rather than printing undefined', () => {
    expect(formatDenial({ reason: 'not_signed_in' })).toBe('reason=not_signed_in')
  })

  it('includes the workflow and the detail when a machine refusal carries them', () => {
    expect(
      formatDenial({
        reason: 'cross_workflow_write',
        workflowId: '0199a1f4-0000-7000-8000-000000000004',
        detail: 'write named a workflow the credential does not cover',
      }),
    ).toContain('workflowId=0199a1f4-0000-7000-8000-000000000004')
  })
})

describe('createLoggingDenialWriter', () => {
  it('reports one prefixed line per denial', async () => {
    const report = vi.fn()
    await createLoggingDenialWriter(report)(NOT_ADMIN)

    expect(report).toHaveBeenCalledExactlyOnceWith(
      'sisyphus.denial reason=not_admin path=admin.users.setRole userId=0199a1f4-0000-7000-8000-000000000003',
    )
  })
})

describe('createDenialRecorder', () => {
  it('hands the denial to the writer', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    await createDenialRecorder(write, vi.fn())(NOT_ADMIN)

    expect(write).toHaveBeenCalledExactlyOnceWith(NOT_ADMIN)
  })

  it('never rejects when the writer fails, so a refusal is not turned into a 500', async () => {
    const report = vi.fn()
    const write = vi.fn().mockRejectedValue(new Error('sink unavailable'))

    await expect(createDenialRecorder(write, report)(NOT_ADMIN)).resolves.toBeUndefined()
    expect(report.mock.calls[0]?.[0]).toContain('sisyphus.denial.record-failed')
    expect(report.mock.calls[0]?.[0]).toContain('sink unavailable')
  })

  it('reports the denial itself alongside the failure, so the event is not lost twice', async () => {
    const report = vi.fn()
    await createDenialRecorder(vi.fn().mockRejectedValue(new Error('down')), report)(NOT_ADMIN)

    expect(report.mock.calls[0]?.[0]).toContain('reason=not_admin')
  })
})

describe('the recorder the route handler uses', () => {
  it('is callable and resolves, which is all the middleware requires of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(recordDenial(NOT_ADMIN)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()

    warn.mockRestore()
  })
})
