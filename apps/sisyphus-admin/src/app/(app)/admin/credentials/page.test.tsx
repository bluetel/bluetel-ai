import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate and a mount. What is asserted is the gate: that a non-admin never reaches the
 * JSX, and that an admin does.
 *
 * `requireAdminPage` is mocked to throw the way Next.js's `notFound()` throws, which is the whole
 * mechanism — a page that awaits it and is refused stops there. The decision behind it is covered
 * against the real `isAdminSessionUser` in `src/server/admin-page-access.test.ts`.
 *
 * The gate matters more here than on most admin pages: FR-004 makes every write on this surface
 * admin-only, and data-model.md's access scoping makes the **reads** admin-only too, because a
 * seat's state tells an engineer nothing they can act on.
 */
const requireAdminPage = vi.fn()

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('./credentials-panel', () => ({ CredentialsPanel: () => null }))

const CredentialsAdminPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  requireAdminPage.mockReset()
})

describe('the /admin/credentials page', () => {
  it('opens with the server gate, before anything is rendered', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await CredentialsAdminPage()

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the gate refuses the caller', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(CredentialsAdminPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
