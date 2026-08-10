import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page is a gate, a parameter read and a mount (T080).
 *
 * Three properties are worth asserting. That the gate runs before anything renders; that the page
 * does **not** resolve the credential, because a page that could title itself with a seat's name
 * would have confirmed the seat exists (FR-190); and that the standing text says where the material
 * goes, since that sentence is the only place an administrator is told why there is nothing on this
 * page to copy (FR-070).
 */
const requireAdminPage = vi.fn()
const panel = vi.fn(() => null)

vi.mock('@sisyphus-admin/server', () => ({ requireAdminPage }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('./credential-login-panel', () => ({ CredentialLoginPanel: panel }))

const CredentialLoginPage = (await import('./page')).default
const { dynamic } = await import('./page')

const params = Promise.resolve({ id: '0199a1f4-0000-7000-8000-000000000090' })

const renderPage = async () => {
  const element = await CredentialLoginPage({ params })
  return JSON.stringify(element, (_key, value: unknown) =>
    typeof value === 'function' ? '[component]' : value,
  )
}

beforeEach(() => {
  requireAdminPage.mockReset()
  panel.mockClear()
})

describe('the /admin/credentials/[id]/login page', () => {
  it('opens with the server gate, before anything is rendered', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    await CredentialLoginPage({ params })

    expect(requireAdminPage).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when the gate refuses the caller', async () => {
    requireAdminPage.mockRejectedValue(new Error('NEXT_NOT_FOUND'))

    await expect(CredentialLoginPage({ params })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('hands the panel the id from the URL and resolves nothing itself', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await renderPage()

    // The heading is fixed text. The seat's name appears inside the panel, from a query the router
    // has already decided the caller may make — a page that titled itself would be the disclosure.
    expect(rendered).toContain('Agent credential')
    expect(rendered).toContain('0199a1f4-0000-7000-8000-000000000090')
  })

  it('says where the material goes, which is why there is nothing here to copy (FR-070)', async () => {
    requireAdminPage.mockResolvedValue({ id: 'admin', role: 'admin' })

    const rendered = await renderPage()

    expect(rendered).toContain('written straight to the secret store')
    expect(rendered).toContain('never sent to this page')
    // And FR-071 stated where an administrator will read it: abandoning is safe and expected.
    expect(rendered).toContain('succeeds, fails or is abandoned')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
