import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate and a mount, and the gate is the requirement (T113, 003/FR-053).
 *
 * FR-053 makes the pool view administrator-only, and data-model.md → Access scoping says why the
 * read is too: a credential is platform infrastructure and its state tells an engineer nothing they
 * can act on. `requireAdminPage` is mocked to throw the way Next.js's `notFound()` throws, which is
 * the whole mechanism — a page that awaits it and is refused stops there, with no markup and no
 * queries mounted.
 *
 * The decision behind it is covered against the real `isAdminSessionUser` in
 * `src/server/admin-page-access.test.ts`, and the router is gated a second time in
 * `packages/sisyphus-api/src/server/admin/credential-pool.ts`.
 */
const requireAdminPage = vi.fn()

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('./credential-pool-panel', () => ({ CredentialPoolPanel: () => null }))

const CredentialPoolAdminPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  requireAdminPage.mockReset()
})

describe('the /admin/credentials/pool page', () => {
  it('opens with the server gate, before anything is rendered (FR-053)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await CredentialPoolAdminPage()

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the caller is not an admin', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(CredentialPoolAdminPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('states SC-011’s distinction before any number appears', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await CredentialPoolAdminPage()
    const header = JSON.stringify(rendered.props)

    // A group with runs waiting on it is under-sized even while other groups sit idle, because
    // those groups' seats cannot serve those runs (FR-063). That is the distinction the whole page
    // exists to make, and it is stated before the figures rather than left to be inferred from them.
    expect(header).toContain('under-sized even while other groups sit idle')
    expect(header).toContain('attached groups')
  })

  it('says why holders are broken down, which is FR-074’s entire content', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await CredentialPoolAdminPage()

    expect(JSON.stringify(rendered.props)).toContain(
      'keeps its seat indefinitely while showing no activity',
    )
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
