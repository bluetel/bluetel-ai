import { describe, expect, it } from 'vitest'

import { createFakeJiraClient } from './client-fake'
import { resolveJiraConfig } from './config'
import { resolvePlatformIdentity, UnknownPlatformIdentityError } from './platform-identity'

const config = (overrides: Record<string, unknown> = {}) =>
  resolveJiraConfig({
    baseUrl: 'https://example.atlassian.net',
    projectPrefix: 'SIS',
    label: 'sisyphus',
    ...overrides,
  })

describe('resolvePlatformIdentity', () => {
  it('derives the identity from the credential when none is configured', async () => {
    const client = createFakeJiraClient({
      currentUser: { accountId: 'bot-account', emailAddress: 'sisyphus@bluetel.co.uk' },
    })

    await expect(resolvePlatformIdentity(config(), client)).resolves.toEqual({
      accountId: 'bot-account',
      emailAddress: 'sisyphus@bluetel.co.uk',
    })
  })

  it('prefers a configured service account, so a credential rotation cannot reopen the loop', async () => {
    const client = createFakeJiraClient({ currentUser: { accountId: 'rotated-account' } })

    const identity = await resolvePlatformIdentity(
      config({ serviceAccount: { accountId: 'original-account' } }),
      client,
    )

    // Comments posted by the original account are still recognised as the platform's own after
    // the credential is swapped, which is what keeps them out of the next prompt.
    expect(identity).toEqual({ accountId: 'original-account' })
    expect(client.currentUserCalls()).toBe(0)
  })

  it('refuses to proceed when no identity can be established', async () => {
    const client = createFakeJiraClient({ currentUser: {} })

    // Proceeding would mean treating every Sisyphus comment as human task input.
    await expect(resolvePlatformIdentity(config(), client)).rejects.toBeInstanceOf(
      UnknownPlatformIdentityError,
    )
  })

  it('propagates an unreachable deployment rather than guessing an identity', async () => {
    const client = createFakeJiraClient({ currentUserError: new Error('ENOTFOUND') })

    await expect(resolvePlatformIdentity(config(), client)).rejects.toThrow('ENOTFOUND')
  })

  it('ignores an empty configured service account and falls back', async () => {
    const client = createFakeJiraClient({ currentUser: { accountId: 'bot-account' } })

    await expect(resolvePlatformIdentity(config({ serviceAccount: {} }), client)).resolves.toEqual({
      accountId: 'bot-account',
    })
  })
})
