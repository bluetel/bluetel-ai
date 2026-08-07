import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate, a parameter read and a mount. Two properties are worth asserting: that the
 * gate runs before anything renders, and that the page does **not** resolve the profile — a page
 * that could title itself with the profile's name would have confirmed the profile exists, which
 * is exactly the disclosure FR-190 forbids.
 */
const requireAdminPage = vi.fn()
const panel = vi.fn(() => null)

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/admin/grants', () => ({ ProfileAccessPanel: panel }))

const ProfileAccessPage = (await import('./page')).default
const { dynamic } = await import('./page')

const params = Promise.resolve({ id: '0199a1f4-0000-7000-8000-000000000090' })

beforeEach(() => {
  requireAdminPage.mockReset()
  panel.mockClear()
})

describe('the /admin/profiles/[id]/access page', () => {
  it('opens with the server gate, before anything is rendered', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await ProfileAccessPage({ params })

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the gate refuses the caller', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(ProfileAccessPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('does not resolve the profile before rendering, so the page cannot confirm it exists', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const element = await ProfileAccessPage({ params })
    const rendered = JSON.stringify(element, (_key, value: unknown) =>
      typeof value === 'function' ? '[component]' : value,
    )

    // The heading is fixed text plus the id from the URL. Nothing is fetched to build it.
    expect(rendered).toContain('Execution profile')
    expect(rendered).toContain('0199a1f4-0000-7000-8000-000000000090')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
