import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { AUTH_ERROR_REASONS } from './error-reason'
import { DEFAULT_REDIRECT_TARGET } from './redirect-target'

/**
 * The route exists, and it renders for someone with no session — that is the defect this page was
 * written to fix, so it is the first thing asserted. `config.ts` points both `pages.signIn` and
 * `pages.error` here, so both entry reasons are covered: a plain unauthenticated visit, and an
 * error return carrying `?error=`.
 *
 * Only Auth.js is replaced. Everything the page actually decides — which reason, which destination
 * — runs for real, because those two conversions are the parts a wrong query string can break.
 */
vi.mock('@sisyphus-admin/lib/auth', () => ({ signIn: vi.fn(() => Promise.resolve()) }))

const SignInPage = (await import('./page')).default
const { dynamic } = await import('./page')

const render = async (searchParams: Record<string, string | string[] | undefined>) =>
  renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve(searchParams) }))

describe('/sign-in, reached without a session', () => {
  it('renders a screen rather than a 404, which is what this route returned before it existed', async () => {
    const markup = await render({})

    expect(markup).toContain('Sign in to the panel')
    expect(markup).toContain('Continue with Google')
  })

  it('resolves no session and reads no environment, so it works for someone with no row', async () => {
    // Nothing is stubbed but `signIn`. A page that called `auth()` or `env` would throw here.
    await expect(render({})).resolves.toContain('<form')
  })

  it('shows no error on an ordinary visit', async () => {
    const markup = await render({})

    expect(markup).not.toContain('E_AUTH_')
    expect(markup).not.toContain('role="alert"')
  })

  it('carries the screen the operator was heading for through the round trip', async () => {
    const markup = await render({ callbackUrl: '/admin/users' })

    expect(markup).toContain('value="/admin/users"')
  })

  it('will not forward a destination that leaves this origin', async () => {
    const markup = await render({ callbackUrl: '//evil.example.com/workflows' })

    expect(markup).toContain(`value="${DEFAULT_REDIRECT_TARGET}"`)
    expect(markup).not.toContain('evil.example.com')
  })

  it('is dynamic, because its output is a function of the query string', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})

describe('/sign-in, reached as an authentication-error return', () => {
  it('names the refusal for the code the sign-in gate produces', async () => {
    const markup = await render({ error: 'AccessDenied' })

    expect(markup).toContain(AUTH_ERROR_REASONS.refused.code)
    expect(markup).toContain('Sign-in was refused')
    expect(markup).toContain('role="alert"')
  })

  it('distinguishes a misconfigured deployment from a failed provider round trip', async () => {
    expect(await render({ error: 'Configuration' })).toContain(
      AUTH_ERROR_REASONS.configuration.code,
    )
    expect(await render({ error: 'OAuthCallbackError' })).toContain(
      AUTH_ERROR_REASONS.provider.code,
    )
  })

  it('does not reflect a hand-written error parameter back into the page', async () => {
    const markup = await render({ error: '<script>alert(1)</script>' })

    expect(markup).toContain(AUTH_ERROR_REASONS.provider.code)
    expect(markup).not.toContain('alert(1)')
  })

  it('never tells a refused visitor whether the identity is one the platform knows (FR-190)', async () => {
    const markup = await render({ error: 'AccessDenied' })

    // The refusal offers both causes and says it will not choose between them, so the page cannot
    // be used to ask "is this address a Sisyphus user?". `error-reason.test.ts` pins the invariant
    // over the whole vocabulary; this pins that the screen renders it unaltered.
    expect(markup).toContain('does not say which')
    expect(markup).not.toMatch(/\b(exists|registered|no such|unknown account|your account)\b/i)
  })

  it('still offers the key, so an error return is not a dead end', async () => {
    const markup = await render({ error: 'AccessDenied' })

    expect(markup).toContain('Continue with Google')
  })
})
