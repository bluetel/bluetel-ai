import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The gate for `/workflows`, which is deliberately **not** the admin gate.
 *
 * `redirect` and `notFound` are Next.js control flow: they throw. The mocks throw too, which is
 * what lets this file assert the property that matters — that a caller who is not entitled never
 * reaches the line after the gate, so no markup is produced and no query is mounted.
 */

const authMock = vi.fn()

vi.mock('@sisyphus-admin/lib/auth', async () => ({
  auth: authMock,
  isActiveSessionUser: (
    await vi.importActual<{ isActiveSessionUser: unknown }>('@sisyphus-admin/lib/auth/session-user')
  ).isActiveSessionUser,
}))

// The server barrel reaches the validated environment and a database handle; only the sign-in path
// matters here, so it is supplied directly rather than booting either.
vi.mock('@sisyphus-admin/server', () => ({ SIGN_IN_PATH: '/sign-in' }))

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))

const WorkflowsLayout = (await import('./layout')).default

const engineer = {
  id: '0199a1f4-0000-7000-8000-000000000007',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  role: 'engineer',
  isActive: true,
}

const children = 'the fleet list'

beforeEach(() => {
  authMock.mockReset()
})

describe('the /workflows gate', () => {
  it('lets a non-admin through — the fleet list is not administration', async () => {
    authMock.mockResolvedValue({ user: engineer })

    await expect(WorkflowsLayout({ children })).resolves.toBe(children)
  })

  it('lets an admin through too', async () => {
    authMock.mockResolvedValue({ user: { ...engineer, role: 'admin' } })

    await expect(WorkflowsLayout({ children })).resolves.toBe(children)
  })

  it('redirects a caller with no session to sign in rather than answering not found', async () => {
    authMock.mockResolvedValue(null)

    await expect(WorkflowsLayout({ children })).rejects.toThrow('REDIRECT:/sign-in')
  })

  it('answers not found for a deactivated user, rather than looping them through sign-in (FR-175)', async () => {
    authMock.mockResolvedValue({ user: { ...engineer, isActive: false } })

    await expect(WorkflowsLayout({ children })).rejects.toThrow('NOT_FOUND')
  })

  it('never mentions permission, for the same reason every out-of-scope read is NOT_FOUND', async () => {
    authMock.mockResolvedValue({ user: { ...engineer, isActive: false } })

    await expect(WorkflowsLayout({ children })).rejects.toThrow(/^NOT_FOUND$/)
  })
})
