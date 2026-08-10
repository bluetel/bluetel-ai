import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate, a parameter read and a mount (T121).
 *
 * Three properties, the same three its `./login` child is held to. That the gate runs before
 * anything renders; that the page does **not** resolve the credential, because a page that could
 * title itself with a seat's name would have confirmed the seat exists (FR-190); and that the
 * standing text states the recovery *order*, since that sentence is the only place an administrator
 * is told that disabling a held seat has not freed it (FR-006, SC-012).
 */
const requireAdminPage = vi.fn()
const panel = vi.fn(() => null)

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('./credential-recovery-panel', () => ({ CredentialRecoveryPanel: panel }))

const CredentialDetailPage = (await import('./page')).default
const { dynamic } = await import('./page')

const params = Promise.resolve({ id: '0199a1f4-0000-7000-8000-000000000091' })

const renderPage = async () => {
  const element = await CredentialDetailPage({ params })
  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

beforeEach(() => {
  requireAdminPage.mockReset()
  panel.mockClear()
})

describe('the /admin/credentials/[id] page', () => {
  it('opens with the server gate, before anything is rendered', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await CredentialDetailPage({ params })

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the gate refuses the caller', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(CredentialDetailPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('hands the panel the id from the URL and resolves nothing itself', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await renderPage()

    expect(rendered).toContain('Agent credential')
    expect(rendered).toContain('0199a1f4-0000-7000-8000-000000000091')
  })

  it('states the recovery order, which is the part that is not obvious (SC-012)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await renderPage()

    expect(rendered).toContain('disable it')
    expect(rendered).toContain('force-release it')
    expect(rendered).toContain('log in again')
    // FR-023, stated where it explains the cost rather than as a rule on its own.
    expect(rendered).toContain('never moved to a different credential')
    // FR-005's shape: not deletable, disableable instead.
    expect(rendered).toContain('Deleting is refused')
    expect(rendered).toContain('disable it instead')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
