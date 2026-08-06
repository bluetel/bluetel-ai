import { describe, expect, it } from 'vitest'

import { isPlatformAuthored } from './is-platform-authored'

const platform = {
  accountId: '5b10ac8d82e05b22cc7d4ef5',
  emailAddress: 'sisyphus@bluetel.co.uk',
}

describe('isPlatformAuthored', () => {
  it('matches on account id', () => {
    expect(isPlatformAuthored({ accountId: platform.accountId }, platform)).toBe(true)
  })

  it('rejects a different account id', () => {
    expect(isPlatformAuthored({ accountId: 'someone-else' }, platform)).toBe(false)
  })

  it('prefers account id over email when both are present', () => {
    const author = { accountId: 'someone-else', emailAddress: platform.emailAddress }

    expect(isPlatformAuthored(author, platform)).toBe(false)
  })

  it('falls back to email when the author has no account id', () => {
    expect(isPlatformAuthored({ emailAddress: 'Sisyphus@Bluetel.co.uk ' }, platform)).toBe(true)
  })

  it('rejects a different email address', () => {
    expect(isPlatformAuthored({ emailAddress: 'harry@bluetel.co.uk' }, platform)).toBe(false)
  })

  it('treats an unidentifiable author as human', () => {
    expect(isPlatformAuthored({}, platform)).toBe(false)
  })

  it('treats every author as human when the platform identity is unknown', () => {
    expect(isPlatformAuthored({ accountId: platform.accountId }, {})).toBe(false)
  })
})
