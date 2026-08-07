import { describe, expect, it, vi } from 'vitest'

/**
 * The page, asserted for the two things a screen behind an admin gate can get wrong invisibly:
 * that the gate runs on the server **before** anything else, and that nothing below it renders when
 * the caller is refused (FR-169, FR-186, FR-190).
 */
const importPage = async (refuse: boolean) => {
  vi.resetModules()
  vi.stubEnv('SKIP_ENV_VALIDATION', 'true')

  const calls: string[] = []

  vi.doMock('@sisyphus-admin/server', () => ({
    requireAdminPage: () => {
      calls.push('gate')
      if (refuse) {
        throw new Error('NEXT_NOT_FOUND')
      }
      return Promise.resolve()
    },
  }))

  const page = await import('./page')

  return { page, calls }
}

describe('/admin/integrations', () => {
  it('is dynamic, because it is a function of the caller session', async () => {
    const { page } = await importPage(false)

    expect(page.dynamic).toBe('force-dynamic')
  })

  it('runs the admin gate before it renders anything (FR-186)', async () => {
    const { page, calls } = await importPage(false)

    await page.default()

    expect(calls).toStrictEqual(['gate'])
  })

  it('renders nothing at all for a caller the gate refuses (FR-190)', async () => {
    const { page } = await importPage(true)

    await expect(page.default()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
