import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The shell, asserted for the four things it exists to guarantee: every authenticated screen is
 * wrapped by it, the role reaches the sidebar from the **server** session, the identity reaches the
 * bar, and a caller who should not see any of it gets no markup at all.
 *
 * `redirect` and `notFound` are Next.js control flow: they throw. The mocks throw too, which is
 * what lets this file assert that a caller who is not entitled never reaches the JSX.
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
vi.mock('@sisyphus-admin/env', () => ({
  env: { NEXT_PUBLIC_SITE_URL: 'https://sisyphus.example.com' },
}))
vi.mock('@sisyphus-admin/trpc', () => ({
  TRPCReactProvider: ({ children }: { children: unknown }) => children,
}))
vi.mock('@sisyphus-admin/components/shell', () => ({
  Sidebar: ({ role }: { role: string }) => <nav data-role={role} />,
  TopBar: ({ displayName, email }: { displayName: string; email: string }) => (
    <header>
      {displayName} {email}
    </header>
  ),
}))

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`)
  },
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
}))

const AppLayout = (await import('./layout')).default
const { dynamic } = await import('./layout')

const engineer = {
  id: '0199a1f4-0000-7000-8000-000000000007',
  email: 'engineer@bluetel.co.uk',
  displayName: 'An Engineer',
  role: 'engineer',
  isActive: true,
}

const children = <p>the screen</p>

const render = async (user: Record<string, unknown> | null) => {
  authMock.mockResolvedValue(user === null ? null : { user })
  return renderToStaticMarkup(<>{await AppLayout({ children })}</>)
}

beforeEach(() => {
  authMock.mockReset()
})

describe('the application shell', () => {
  it('wraps the screen rather than replacing it', async () => {
    expect(await render(engineer)).toContain('the screen')
  })

  it('hands the sidebar the role from the server session, so the nav is not a client decision', async () => {
    expect(await render(engineer)).toContain('data-role="engineer"')
    expect(await render({ ...engineer, role: 'admin' })).toContain('data-role="admin"')
  })

  it('hands the bar the signed-in identity (FR-194)', async () => {
    const markup = await render(engineer)

    expect(markup).toContain('An Engineer')
    expect(markup).toContain('engineer@bluetel.co.uk')
  })

  it('opens one main landmark, with the id the skip link targets (FR-201)', async () => {
    const markup = await render(engineer)

    expect(markup.match(/<main/g)).toHaveLength(1)
    expect(markup).toContain('id="main-content"')
    expect(markup).toContain('href="#main-content"')
  })

  it('puts the skip link before the nav, so a keyboard user is not walked through it', async () => {
    const markup = await render(engineer)

    expect(markup.indexOf('Skip to content')).toBeLessThan(markup.indexOf('<nav'))
  })

  it('holds the screen to the column ceiling inside the page gutter', async () => {
    const markup = await render(engineer)

    expect(markup).toContain('max-w-column')
    expect(markup).toContain('p-gutter')
  })

  it('carries no literal colour, size or radius (SC-015)', async () => {
    expect(await render(engineer)).not.toMatch(/#[0-9a-fA-F]{3,8}|\d+(?:px|rem)/)
  })

  it('is dynamic, because its output is a function of the caller’s session', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})

describe('who the shell refuses', () => {
  it('redirects a caller with no session to sign in rather than answering not found', async () => {
    authMock.mockResolvedValue(null)

    await expect(AppLayout({ children })).rejects.toThrow('REDIRECT:/sign-in')
  })

  it('answers not found for a deactivated user, rather than looping them through sign-in (FR-175)', async () => {
    authMock.mockResolvedValue({ user: { ...engineer, isActive: false } })

    await expect(AppLayout({ children })).rejects.toThrow('NOT_FOUND')
  })

  it('produces no markup when it refuses — the screen below is never evaluated', async () => {
    authMock.mockResolvedValue(null)

    await expect(AppLayout({ children })).rejects.toThrow(/^REDIRECT:/)
  })
})
