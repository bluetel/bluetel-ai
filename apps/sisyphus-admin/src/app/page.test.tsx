import type { SisyphusSessionUser } from '@sisyphus-admin/lib/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A signpost is only correct if it never renders. Every case below asserts both halves: where the
 * caller was sent, and that the component threw on the way rather than returning markup — which is
 * what `redirect` does in Next.js and what makes `/` incapable of being a dead end (FR-196).
 */

const { auth, redirect } = vi.hoisted(() => ({
  auth: vi.fn((): Promise<{ user?: SisyphusSessionUser } | null> => Promise.resolve(null)),
  redirect: vi.fn((path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`)
  }),
}))

vi.mock('next/navigation', () => ({ redirect }))

vi.mock('@sisyphus-admin/lib/auth', async () => {
  // The real activation predicate, so the case that decides this page is exercised rather than
  // restated. Only the session read is replaced.
  const actual = await vi.importActual<{ isActiveSessionUser: unknown }>(
    '@sisyphus-admin/lib/auth/session-user',
  )
  return { auth, isActiveSessionUser: actual.isActiveSessionUser }
})

vi.mock('@sisyphus-admin/server', () => ({ SIGN_IN_PATH: '/sign-in' }))

const RootPage = (await import('./page')).default
const { dynamic } = await import('./page')

const user = (overrides: Partial<SisyphusSessionUser> = {}): SisyphusSessionUser => ({
  id: 'user-1',
  email: 'engineer@example.com',
  displayName: 'An Engineer',
  role: 'engineer',
  isActive: true,
  ...overrides,
})

/** Runs the page and reports where it sent the caller, failing if it rendered anything instead. */
const destinationOf = async (session: { user?: SisyphusSessionUser } | null): Promise<string> => {
  auth.mockResolvedValueOnce(session)
  await expect(RootPage()).rejects.toThrow(/^NEXT_REDIRECT:/)
  return String(redirect.mock.calls.at(-1)?.[0])
}

describe('the root route', () => {
  beforeEach(() => {
    redirect.mockClear()
  })

  it('sends an active session to the workflow list', async () => {
    expect(await destinationOf({ user: user() })).toBe('/workflows')
  })

  it('sends an active admin to the same place — the landing screen is not role-dependent', async () => {
    expect(await destinationOf({ user: user({ role: 'admin' }) })).toBe('/workflows')
  })

  it('sends a caller with no session to sign in', async () => {
    expect(await destinationOf(null)).toBe('/sign-in')
  })

  it('sends a session with no user to sign in', async () => {
    expect(await destinationOf({})).toBe('/sign-in')
  })

  it('sends a deactivated session to sign in rather than into a panel that will refuse it', async () => {
    expect(await destinationOf({ user: user({ isActive: false }) })).toBe('/sign-in')
  })

  it('renders nothing in any case — it is a signpost, not a screen', async () => {
    await destinationOf(null)

    expect(redirect).toHaveBeenCalledTimes(1)
  })

  it('is dynamic, because the answer is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
