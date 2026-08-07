import { describe, expect, it, vi } from 'vitest'

/**
 * The sign-out action, asserted for the two things SC-058 turns on: that it calls the **server**
 * `signOut` rather than clearing something in the browser, and that it lands the caller on the
 * sign-in screen rather than on a page they can no longer render.
 */
const signOut = vi.fn(() => Promise.resolve())

vi.mock('@sisyphus-admin/lib/auth', () => ({ signOut }))

// The server barrel reaches the validated environment and a database handle; only the sign-in path
// matters here, so it is supplied directly rather than booting either.
vi.mock('@sisyphus-admin/server', () => ({ SIGN_IN_PATH: '/sign-in' }))

const { signOutAction } = await import('./sign-out-action')

describe('the sign-out action', () => {
  it('ends the session through the auth layer, not by dropping a cookie in the client', async () => {
    await signOutAction()

    expect(signOut).toHaveBeenCalledOnce()
  })

  it('returns the user to the sign-in screen (FR-194)', async () => {
    signOut.mockClear()
    await signOutAction()

    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/sign-in' })
  })

  it('is a server action, so the control that calls it works without JavaScript', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./sign-out-action.ts', import.meta.url), 'utf8'),
    )

    expect(source.startsWith("'use server'")).toBe(true)
  })
})
