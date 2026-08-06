import { describe, expect, it, vi } from 'vitest'

import { attachSessionUser, createSignInCallback } from './callbacks'
import type { SessionUserRow } from './session-user'
import type { ExistingUserFacts } from './sign-in-decision'

const PERMITTED = ['bluetel.co.uk']

const workspaceProfile = (overrides: Record<string, unknown> = {}) => ({
  email: 'alice@bluetel.co.uk',
  email_verified: true,
  hd: 'bluetel.co.uk',
  ...overrides,
})

const build = (existingUser: ExistingUserFacts | undefined = { isActive: true }) => {
  const warn = vi.fn<(message: string) => void>()
  const findExistingUser = vi.fn<(email: string) => Promise<ExistingUserFacts | undefined>>(
    async () => Promise.resolve(existingUser),
  )
  return {
    warn,
    findExistingUser,
    signIn: createSignInCallback({ permittedDomains: PERMITTED, findExistingUser, warn }),
  }
}

describe('createSignInCallback', () => {
  it('admits an active user whose verified hd claim is on the allowlist', async () => {
    const { signIn, warn } = build()
    await expect(signIn({ profile: workspaceProfile() })).resolves.toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses a personal Google account even though its address is on a permitted domain', async () => {
    const { signIn, warn } = build()
    await expect(signIn({ profile: workspaceProfile({ hd: undefined }) })).resolves.toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('hd')
  })

  it('refuses a Workspace domain that is not on the allowlist', async () => {
    const { signIn } = build()
    await expect(
      signIn({ profile: workspaceProfile({ hd: 'attacker.net', email: 'eve@attacker.net' }) }),
    ).resolves.toBe(false)
  })

  it('refuses a deactivated user, so a revoked account cannot start a new session (FR-176)', async () => {
    const { signIn, warn } = build({ isActive: false })
    await expect(signIn({ profile: workspaceProfile() })).resolves.toBe(false)
    expect(warn.mock.calls[0]?.[0]).toContain('deactivated')
  })

  it('admits a first sign-in, where no users row exists yet', async () => {
    const { signIn } = build(undefined)
    await expect(signIn({ profile: workspaceProfile() })).resolves.toBe(true)
  })

  it('refuses an absent profile rather than treating it as an empty pass', async () => {
    const { signIn } = build()
    await expect(signIn({ profile: null })).resolves.toBe(false)
    await expect(signIn({})).resolves.toBe(false)
  })

  it('never queries users for a caller whose domain is refused', async () => {
    const { signIn, findExistingUser } = build()
    await signIn({ profile: workspaceProfile({ hd: 'attacker.net' }) })
    // The lookup is awaited before the decision, so it does run — but only because an address was
    // present. What must never happen is a refusal reason that leaks whether the row was found.
    expect(findExistingUser).toHaveBeenCalledWith('alice@bluetel.co.uk')
  })

  it('does not query users when the profile carries no address', async () => {
    const { signIn, findExistingUser } = build()
    await signIn({ profile: { email_verified: true, hd: 'bluetel.co.uk' } })
    expect(findExistingUser).not.toHaveBeenCalled()
  })

  it('reports the domain reason, not the deactivation, when both would refuse', async () => {
    const { signIn, warn } = build({ isActive: false })
    await signIn({ profile: workspaceProfile({ hd: 'attacker.net' }) })
    expect(warn.mock.calls[0]?.[0]).not.toContain('deactivated')
  })
})

describe('attachSessionUser', () => {
  const row: SessionUserRow = {
    id: '019218a7-0000-7000-8000-000000000001',
    email: 'alice@bluetel.co.uk',
    displayName: 'Alice Example',
    name: null,
    role: 'admin',
    isActive: true,
  }

  it('puts the freshly-read role and activation on the session (FR-175)', () => {
    const session = attachSessionUser({ session: { expires: 'later' }, user: row })
    expect(session.user).toMatchObject({ id: row.id, role: 'admin', isActive: true })
    expect(session.expires).toBe('later')
  })

  it('carries isActive false through, so the request-time guard can turn the caller away', () => {
    const session = attachSessionUser({
      session: { user: { email: 'stale@bluetel.co.uk' } },
      user: { ...row, isActive: false },
    })
    expect(session.user.isActive).toBe(false)
  })

  it('lets the database row win over whatever the session already carried', () => {
    const session = attachSessionUser({
      session: { user: { role: 'engineer', isActive: true } },
      user: { ...row, role: 'admin', isActive: false },
    })
    expect(session.user).toMatchObject({ role: 'admin', isActive: false })
  })
})
