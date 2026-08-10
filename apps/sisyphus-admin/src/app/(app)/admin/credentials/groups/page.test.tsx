import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate and a mount, and the gate is the requirement (T026, FR-067).
 *
 * A non-admin able to edit credential groups could attach capacity to a profile they hold or
 * withdraw it from one they do not, and FR-063's scoping would stop meaning anything.
 * `requireAdminPage` is mocked to throw the way Next.js's `notFound()` throws, which is the whole
 * mechanism: a page that awaits it and is refused stops there — no markup, no queries mounted.
 *
 * The decision behind it is covered against the real `isAdminSessionUser` in
 * `src/server/admin-page-access.test.ts`, and the router is gated a second time in
 * `packages/sisyphus-api/src/server/admin/credential-groups.ts`.
 */
const requireAdminPage = vi.fn()

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/admin/credential-groups', () => ({
  CredentialGroupsPanel: () => null,
}))

const CredentialGroupsAdminPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  requireAdminPage.mockReset()
})

describe('the /admin/credentials/groups page', () => {
  it('opens with the server gate, before anything is rendered (FR-067)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await CredentialGroupsAdminPage()

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the caller is not an admin', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(CredentialGroupsAdminPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('says up front that disabling is what FR-066 offers in place of deleting', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await CredentialGroupsAdminPage()

    expect(JSON.stringify(rendered.props)).toContain('it is disabled instead')
  })

  it('says a credential belongs to exactly one group (FR-061)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await CredentialGroupsAdminPage()

    expect(JSON.stringify(rendered.props)).toContain('belongs to exactly one')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
