import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate and two mounts, and the gate is the requirement (T082, FR-185).
 *
 * A non-admin able to edit a workspace or a profile could point a profile they hold at a repository
 * or setup bundle they were never granted, which would defeat the access model entirely.
 * `requireAdminPage` is mocked to throw the way Next.js's `notFound()` throws, which is the whole
 * mechanism: a page that awaits it and is refused stops there — no markup, no queries mounted.
 *
 * The decision behind it is covered against the real `isAdminSessionUser` in
 * `src/server/admin-page-access.test.ts`, and each router is gated a second time in
 * `packages/sisyphus-api/src/server/admin/`.
 */
const requireAdminPage = vi.fn()

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/admin/profiles', () => ({ ProfilesPanel: () => null }))
vi.mock('@sisyphus-admin/components/admin/workspaces', () => ({ WorkspacesPanel: () => null }))

const ProfilesAdminPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  requireAdminPage.mockReset()
})

describe('the /admin/profiles page', () => {
  it('opens with the server gate, before anything is rendered (FR-185)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await ProfilesAdminPage()

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the caller is not an admin', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(ProfilesAdminPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('says versioning is the point, in the one sentence every visitor reads (FR-125)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await ProfilesAdminPage()

    expect(JSON.stringify(rendered.props)).toContain('keeps the version it pinned when it launched')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
