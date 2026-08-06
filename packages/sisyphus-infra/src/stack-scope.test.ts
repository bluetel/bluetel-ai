import { describe, expect, it } from 'vitest'

import { getResourceIdentifier } from './lib'
import { SISYPHUS_PROJECT, getStackScope } from './stack-scope'

describe('getStackScope', () => {
  it('names resources under the shared project rather than the deployable', () => {
    expect(getStackScope('staging')).toEqual({ project: SISYPHUS_PROJECT, stack: 'staging' })
  })

  it('collapses every auxiliary stage onto its plain stage', () => {
    expect(getStackScope('production-bootstrap').stack).toBe('production')
    expect(getStackScope('production-website').stack).toBe('production')
    expect(getStackScope('production').stack).toBe('production')
  })

  it('gives the three deployables the same name for a shared resource', () => {
    const fromPanel = getResourceIdentifier(getStackScope('production-website'), 'artifacts')
    const fromControlPlane = getResourceIdentifier(getStackScope('production'), 'artifacts')

    expect(fromPanel).toBe('sisyphus-production-artifacts')
    expect(fromControlPlane).toBe(fromPanel)
  })

  it('refuses an empty stage rather than naming resources "sisyphus--artifacts"', () => {
    expect(() => getStackScope('')).toThrow('empty stage name')
    expect(() => getStackScope('   ')).toThrow('empty stage name')
  })
})
