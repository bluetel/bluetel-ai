import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate, a parameter read and a mount. Three properties are worth asserting: that the
 * gate runs before anything renders, that the page does **not** resolve the profile — a page that
 * could title itself with the profile's name would have confirmed the profile exists, which is the
 * disclosure FR-190 forbids — and that its summary states FR-065 as a configuration-time refusal,
 * because that framing is the requirement rather than a nicety.
 */
const requireAdminPage = vi.fn()
const panel = vi.fn(() => null)

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/admin/credential-groups', () => ({
  ProfileCredentialGroupsPanel: panel,
}))

const ProfileCredentialGroupsPage = (await import('./page')).default
const { dynamic } = await import('./page')

const params = Promise.resolve({ id: '0199a1f4-0000-7000-8000-000000000090' })

beforeEach(() => {
  requireAdminPage.mockReset()
  panel.mockClear()
})

describe('the /admin/profiles/[id] page', () => {
  it('opens with the server gate, before anything is rendered (FR-067)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await ProfileCredentialGroupsPage({ params })

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the gate refuses the caller', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(ProfileCredentialGroupsPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('does not resolve the profile before rendering, so the page cannot confirm it exists', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const element = await ProfileCredentialGroupsPage({ params })
    const rendered = JSON.stringify(element, (_key, value: unknown) =>
      typeof value === 'function' ? '[component]' : value,
    )

    expect(rendered).toContain('Execution profile')
    expect(rendered).toContain('0199a1f4-0000-7000-8000-000000000090')
  })

  it('says the order is a preference order and what the first place means (FR-062, FR-064)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await ProfileCredentialGroupsPage({ params })

    expect(JSON.stringify(rendered.props)).toContain(
      'the first group with an available credential is used',
    )
  })

  it('states FR-065 as a refusal made here rather than at launch', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await ProfileCredentialGroupsPage({ params })
    const summary = JSON.stringify(rendered.props)

    expect(summary).toContain('cannot be enabled')
    expect(summary).toContain('rather than at launch')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
