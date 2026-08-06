import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `redirect` and `notFound` are Next.js control flow: they throw. The mocks throw too, which is
 * what lets this file assert the property that matters — that a refused caller never reaches the
 * line after the gate.
 */
const authMock = vi.fn()

// The real guard is pulled in from the module it lives in — the barrel itself reaches Auth.js and
// the validated environment, neither of which this file has anything to say about — so the gate is
// exercised against the same `isAdminSessionUser` the application runs.
vi.mock('@sisyphus-admin/lib/auth', async () => ({
  auth: authMock,
  isAdminSessionUser: (
    await vi.importActual<{ isAdminSessionUser: unknown }>('@sisyphus-admin/lib/auth/session-user')
  ).isAdminSessionUser,
}))

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))

const { requireAdminPage } = await import('./require-admin-page')

const admin = {
  id: '0199a1f4-0000-7000-8000-000000000006',
  email: 'admin@bluetel.co.uk',
  displayName: 'An Admin',
  role: 'admin',
  isActive: true,
}

beforeEach(() => {
  authMock.mockReset()
})

describe('requireAdminPage', () => {
  it('returns the caller when they are an active admin', async () => {
    authMock.mockResolvedValue({ user: admin })

    await expect(requireAdminPage()).resolves.toStrictEqual(admin)
  })

  it('redirects a signed-out caller to the sign-in page', async () => {
    authMock.mockResolvedValue(null)

    await expect(requireAdminPage()).rejects.toThrow('REDIRECT:/sign-in')
  })

  it('answers not found for an engineer, so the page cannot render for them', async () => {
    authMock.mockResolvedValue({ user: { ...admin, role: 'engineer' } })

    await expect(requireAdminPage()).rejects.toThrow('NOT_FOUND')
  })

  it('answers not found for a deactivated admin', async () => {
    authMock.mockResolvedValue({ user: { ...admin, isActive: false } })

    await expect(requireAdminPage()).rejects.toThrow('NOT_FOUND')
  })

  it('never resolves to a value for a caller it refused', async () => {
    authMock.mockResolvedValue({ user: { ...admin, role: 'engineer' } })

    // The point of `notFound()` throwing: a page awaiting this never continues to its JSX.
    const outcome = await requireAdminPage().then(
      () => 'rendered',
      () => 'stopped',
    )

    expect(outcome).toBe('stopped')
  })
})
