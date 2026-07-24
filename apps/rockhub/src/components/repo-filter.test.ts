import pino from 'pino'
import { describe, it, expect } from 'vitest'

import { createRepoFilter } from './repo-filter'

const logger = pino({ level: 'silent' })

describe('createRepoFilter', () => {
  it('accepts all repos when both lists are null', () => {
    const filter = createRepoFilter({ allowedRepos: null, deniedRepos: null }, logger)
    expect(filter('owner/repo')).toBe(true)
    expect(filter('any/thing')).toBe(true)
  })

  it('rejects repos not in allowedRepos when allowedRepos is set', () => {
    const filter = createRepoFilter({ allowedRepos: ['owner/repo'], deniedRepos: null }, logger)
    expect(filter('owner/repo')).toBe(true)
    expect(filter('other/repo')).toBe(false)
  })

  it('rejects repos in deniedRepos when deniedRepos is set', () => {
    const filter = createRepoFilter({ allowedRepos: null, deniedRepos: ['bad/repo'] }, logger)
    expect(filter('good/repo')).toBe(true)
    expect(filter('bad/repo')).toBe(false)
  })

  it('applies allowedRepos first, then deniedRepos', () => {
    // Repo is in both lists: allowed first passes, denied second rejects
    const filter = createRepoFilter(
      { allowedRepos: ['owner/repo'], deniedRepos: ['owner/repo'] },
      logger,
    )
    expect(filter('owner/repo')).toBe(false)
  })

  it('rejects repos not in allowedRepos even if deniedRepos is null', () => {
    const filter = createRepoFilter({ allowedRepos: ['a/b'], deniedRepos: null }, logger)
    expect(filter('c/d')).toBe(false)
  })

  it('accepts repos in allowedRepos that are not in deniedRepos', () => {
    const filter = createRepoFilter({ allowedRepos: ['a/b', 'c/d'], deniedRepos: ['x/y'] }, logger)
    expect(filter('a/b')).toBe(true)
    expect(filter('c/d')).toBe(true)
  })
})
