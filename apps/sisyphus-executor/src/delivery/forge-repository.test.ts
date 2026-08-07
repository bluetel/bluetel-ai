import { describe, expect, it } from 'vitest'

import {
  parseRepositoryLocation,
  parseRepositorySlug,
  repositoryLocationError,
  repositorySlugError,
  withoutUserInfo,
} from './forge-repository'

/**
 * Six ways of writing one repository, all of which the workspace configuration
 * can legitimately contain. A client that handled five would report the sixth
 * as a 404, which pushed-commit verification renders to the engineer as "your
 * branch is not on the forge" — a wrong answer to the question that path
 * exists to answer correctly.
 */

const FORMS = [
  'https://forge.example/acme/web',
  'https://forge.example/acme/web.git',
  'https://forge.example/acme/web/',
  'ssh://git@forge.example/acme/web.git',
  'git@forge.example:acme/web.git',
  'acme/web',
]

describe('parseRepositorySlug', () => {
  it.each(FORMS)('reads acme/web out of %s', (reference) => {
    expect(parseRepositorySlug(reference)).toStrictEqual({
      owner: 'acme',
      name: 'web',
      path: 'acme/web',
    })
  })

  it('ignores a port, a mount prefix and surrounding whitespace', () => {
    expect(parseRepositorySlug('  https://forge.example:8443/git/acme/web.git ').path).toBe(
      'acme/web',
    )
  })

  it('takes the last two segments, so a nested group still names its repository', () => {
    expect(parseRepositorySlug('https://forge.example/acme/platform/web').path).toBe('platform/web')
  })

  it('refuses a reference that names no owner', () => {
    expect(() => parseRepositorySlug('https://forge.example/web')).toThrow(/does not name an owner/)
  })

  it('refuses an empty reference rather than addressing something arbitrary', () => {
    expect(() => parseRepositorySlug('   ')).toThrow(/does not name an owner/)
  })

  it('strips the credential a clone url can carry before parsing it', () => {
    expect(
      parseRepositorySlug('https://x-access-token:s3cr3t-token@forge.example/acme/web').path,
    ).toBe('acme/web')
  })
})

describe('withoutUserInfo', () => {
  it('removes a user and password from a clone url', () => {
    expect(withoutUserInfo('https://someone@acme.test:s3cr3t@forge.example/acme/web')).toBe(
      'https://forge.example/acme/web',
    )
  })

  it('removes the user from an scp-style reference', () => {
    expect(withoutUserInfo('git@forge.example:acme/web.git')).toBe('forge.example:acme/web.git')
  })

  it('leaves a reference with no user information alone', () => {
    expect(withoutUserInfo('https://forge.example/acme/web')).toBe('https://forge.example/acme/web')
  })
})

describe('parseRepositoryLocation', () => {
  it.each(FORMS.filter((reference) => reference !== 'acme/web'))(
    'reads forge.example out of %s',
    (reference) => {
      expect(parseRepositoryLocation(reference)).toStrictEqual({
        host: 'forge.example',
        protocol: 'https',
      })
    },
  )

  it('keeps a web port, because a credential is stored against host and port together', () => {
    expect(parseRepositoryLocation('https://forge.example:8443/git/acme/web.git')).toStrictEqual({
      host: 'forge.example:8443',
      protocol: 'https',
    })
  })

  it('drops an ssh port, which names nothing an https credential was stored against', () => {
    expect(parseRepositoryLocation('ssh://git@forge.example:2222/acme/web.git')).toStrictEqual({
      host: 'forge.example',
      protocol: 'https',
    })
  })

  it('keeps http as http rather than upgrading a reference nobody wrote as secure', () => {
    expect(parseRepositoryLocation('http://forge.internal/acme/web')).toStrictEqual({
      host: 'forge.internal',
      protocol: 'http',
    })
  })

  it('strips the credential a clone url can carry before reading the host', () => {
    expect(
      parseRepositoryLocation('https://x-access-token:s3cr3t-token@forge.example/acme/web').host,
    ).toBe('forge.example')
  })

  it('ignores surrounding whitespace, as the slug parser does', () => {
    expect(parseRepositoryLocation('  https://forge.example/acme/web  ').host).toBe('forge.example')
  })

  it('refuses a bare owner/name, which names no host to ask anything of', () => {
    expect(() => parseRepositoryLocation('acme/web')).toThrow(/names no host/u)
  })

  it('refuses an empty reference', () => {
    expect(() => parseRepositoryLocation('   ')).toThrow(/names no host/u)
  })
})

describe('repositoryLocationError', () => {
  it('never quotes a credential back, because the message reaches a run record (FR-072)', () => {
    const message = repositoryLocationError(
      'https://x-access-token:s3cr3t-token@forge.example/acme/web',
    ).message

    expect(message).not.toContain('s3cr3t-token')
    expect(message).toContain('forge.example/acme/web')
  })
})

describe('repositorySlugError', () => {
  it('never quotes a credential back, because the message reaches a run record (FR-072)', () => {
    const message = repositorySlugError(
      'https://x-access-token:s3cr3t-token@forge.example/web',
    ).message

    expect(message).not.toContain('s3cr3t-token')
    expect(message).toContain('forge.example/web')
  })

  it('says no pull request was opened, which is the fact the engineer needs', () => {
    expect(repositorySlugError('nonsense').message).toContain('No pull request was opened')
  })
})
