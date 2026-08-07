import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate and a mount. What is asserted is the gate: that a non-admin never reaches the
 * JSX, and that an admin does.
 *
 * `requireAdminPage` is mocked to throw the way Next.js's `notFound()` throws, which is the whole
 * mechanism — a page that awaits it and is refused stops there. The decision behind it is covered
 * against the real `isAdminSessionUser` in `src/server/admin-page-access.test.ts`.
 */
const requireAdminPage = vi.fn()

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/admin/users', () => ({
  UsersPanel: () => null,
}))

const UsersPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  requireAdminPage.mockReset()
})

describe('the /admin/users page', () => {
  it('opens with the server gate, before anything is rendered', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await UsersPage()

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the gate refuses the caller', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(UsersPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
