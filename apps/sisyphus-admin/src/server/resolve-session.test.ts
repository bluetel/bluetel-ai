import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `auth()` is mocked rather than driven, because what is worth asserting here is the wiring: that
 * the resolver asks Auth.js on every call — never a cached answer — and hands the result through
 * the projection. Whether the projection is right is `to-sisyphus-session.test.ts`'s job.
 *
 * Mocking the auth barrel also keeps the validated environment out of this file: the real barrel
 * reaches `env` on import, and this module has nothing to say about environment validation.
 */
const authMock = vi.fn()

vi.mock('@sisyphus-admin/lib/auth', () => ({ auth: authMock }))

const { resolveSisyphusSession } = await import('./resolve-session')

const ADMIN = {
  id: '0199a1f4-0000-7000-8000-000000000002',
  email: 'admin@bluetel.co.uk',
  displayName: 'An Admin',
  role: 'admin',
  isActive: true,
}

beforeEach(() => {
  authMock.mockReset()
})

describe('resolveSisyphusSession', () => {
  it('projects the session Auth.js resolved', async () => {
    authMock.mockResolvedValue({ user: ADMIN, expires: '2026-08-06T09:00:00.000Z' })

    await expect(resolveSisyphusSession()).resolves.toStrictEqual({
      user: {
        id: ADMIN.id,
        email: ADMIN.email,
        displayName: ADMIN.displayName,
        role: 'admin',
        isActive: true,
      },
      expiresAt: new Date('2026-08-06T09:00:00.000Z'),
    })
  })

  it('reports no session when nobody is signed in', async () => {
    authMock.mockResolvedValue(null)
    await expect(resolveSisyphusSession()).resolves.toBeNull()
  })

  it('re-asks on every call, which is what makes a deactivation land at the next request', async () => {
    authMock.mockResolvedValueOnce({ user: ADMIN, expires: '2026-08-06T09:00:00.000Z' })
    authMock.mockResolvedValueOnce({
      user: { ...ADMIN, isActive: false },
      expires: '2026-08-06T09:00:00.000Z',
    })

    expect((await resolveSisyphusSession())?.user.isActive).toBe(true)
    expect((await resolveSisyphusSession())?.user.isActive).toBe(false)
    expect(authMock).toHaveBeenCalledTimes(2)
  })

  it('is callable where a (headers) => … resolver is expected', () => {
    const asDependency: (headers: Headers) => Promise<unknown> = resolveSisyphusSession
    expect(typeof asDependency).toBe('function')
  })
})
