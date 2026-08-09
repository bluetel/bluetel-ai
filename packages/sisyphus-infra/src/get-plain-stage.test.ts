import { describe, expect, it } from 'vitest'

import {
  BOOTSTRAP_STAGE_SUFFIX,
  WEBSITE_STAGE_SUFFIX,
  getPlainStage,
  isBootstrapStage,
} from './get-plain-stage'

describe('getPlainStage', () => {
  it('strips the -bootstrap suffix', () => {
    expect(getPlainStage('production-bootstrap')).toBe('production')
  })

  it('strips the -website suffix', () => {
    expect(getPlainStage('staging-website')).toBe('staging')
  })

  it('returns a plain stage unchanged', () => {
    expect(getPlainStage('staging')).toBe('staging')
  })

  it('leaves an unknown suffix in place', () => {
    expect(getPlainStage('staging-executor')).toBe('staging-executor')
  })

  it('only strips a suffix at the end of the stage name', () => {
    expect(getPlainStage('bootstrap-staging')).toBe('bootstrap-staging')
  })

  it('is idempotent', () => {
    const once = getPlainStage('local-bootstrap')

    expect(once).toBe('local')
    expect(getPlainStage(once)).toBe(once)
  })

  it('returns an empty string unchanged', () => {
    expect(getPlainStage('')).toBe('')
  })
})

describe('isBootstrapStage', () => {
  it('recognises the account-level stage', () => {
    expect(isBootstrapStage(`production${BOOTSTRAP_STAGE_SUFFIX}`)).toBe(true)
    expect(isBootstrapStage('production')).toBe(false)
    expect(isBootstrapStage(`production${WEBSITE_STAGE_SUFFIX}`)).toBe(false)
  })

  it('agrees with the suffix getPlainStage strips', () => {
    const sstStage = `staging${BOOTSTRAP_STAGE_SUFFIX}`

    expect(isBootstrapStage(sstStage)).toBe(true)
    expect(getPlainStage(sstStage)).toBe('staging')
  })
})
