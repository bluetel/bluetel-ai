import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_REDIRECT_TARGET, REDIRECT_TARGET_FIELD } from './redirect-target'

/**
 * The action is three lines of wiring, and all three are worth pinning: the single provider is
 * named rather than read from the form, the destination goes through the same-site check, and
 * nothing in this suite reaches Auth.js, Google or a database.
 */

const { signIn } = vi.hoisted(() => ({
  signIn: vi.fn<(provider: string, options: { readonly redirectTo: string }) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}))

vi.mock('@sisyphus-admin/lib/auth', () => ({ signIn }))

const { startGoogleSignIn } = await import('./sign-in-action')

const submit = async (redirectTo?: string) => {
  const form = new FormData()
  if (redirectTo !== undefined) form.set(REDIRECT_TARGET_FIELD, redirectTo)
  await startGoogleSignIn(form)
  return signIn.mock.calls.at(-1)
}

describe('startGoogleSignIn', () => {
  beforeEach(() => {
    signIn.mockClear()
  })

  it('starts the one provider the panel has, without consulting the form for which', async () => {
    expect(await submit()).toStrictEqual(['google', { redirectTo: DEFAULT_REDIRECT_TARGET }])
  })

  it('returns the operator to the screen they were refused at', async () => {
    expect(await submit('/workflows/abc-123')).toStrictEqual([
      'google',
      { redirectTo: '/workflows/abc-123' },
    ])
  })

  it('does not forward a destination that could leave this origin', async () => {
    expect(await submit('//evil.example.com/workflows')).toStrictEqual([
      'google',
      { redirectTo: DEFAULT_REDIRECT_TARGET },
    ])
  })
})
