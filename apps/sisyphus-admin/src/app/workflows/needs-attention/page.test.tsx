import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page resolves who is asking and mounts the panel (T088, FR-135).
 *
 * The owner comes from the **session**, never from a search parameter: a page that took an owner id
 * would be a way to ask what is waiting on somebody else, which is a different screen with
 * different rules — and, the id being the caller's guess, an enumeration oracle dressed as a
 * filter. That is the assertion worth making here.
 */
const auth = vi.fn()
const isAdminSessionUser = vi.fn()
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})

vi.mock('@sisyphus-admin/lib/auth', () => ({ auth, isAdminSessionUser }))
vi.mock('next/navigation', () => ({ notFound }))
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/components/workflows/needs-attention', () => ({
  NeedsAttentionPanel: () => null,
}))

const NeedsAttentionPage = (await import('./page')).default
const { dynamic } = await import('./page')

beforeEach(() => {
  auth.mockReset()
  isAdminSessionUser.mockReset()
  notFound.mockClear()
})

const renderFor = async (user: { id: string } | undefined, admin: boolean) => {
  auth.mockResolvedValue(user === undefined ? null : { user })
  isAdminSessionUser.mockReturnValue(admin)
  return NeedsAttentionPage()
}

describe('the /workflows/needs-attention page', () => {
  it('scopes the view to the signed-in user, read from the session (FR-135)', async () => {
    const rendered = await renderFor({ id: 'engineer-1' }, false)

    expect(JSON.stringify(rendered.props)).toContain('"viewerUserId":"engineer-1"')
  })

  it('does not mount the reassignment queue for a non-admin', async () => {
    const rendered = await renderFor({ id: 'engineer-1' }, false)

    expect(JSON.stringify(rendered.props)).toContain('"canReassign":false')
  })

  it('mounts it for an admin, who is the only one who can clear it (FR-134)', async () => {
    const rendered = await renderFor({ id: 'admin-1' }, true)

    expect(JSON.stringify(rendered.props)).toContain('"canReassign":true')
  })

  it('renders nothing rather than asking for everything owned by nobody', async () => {
    await expect(renderFor(undefined, false)).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
