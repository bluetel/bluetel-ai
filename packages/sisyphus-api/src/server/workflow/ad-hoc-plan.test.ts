import { describe, expect, it } from 'vitest'

import type { StartAdHocInput } from '../../schemas'

import {
  adHocWorkspaceName,
  deriveSubdirectory,
  resolveAdHocJobSpec,
  willSaveAsProfile,
} from './ad-hoc-plan'

const WORKSPACE_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const launch = (overrides: Partial<StartAdHocInput> = {}): StartAdHocInput => ({
  setupBundleVersionId: WORKSPACE_ID,
  workflowType: 'delegated',
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  prompt: 'Do the thing.',
  workspace: { source: 'workspace', workspaceVersionId: WORKSPACE_ID },
  ...overrides,
})

describe('resolveAdHocJobSpec', () => {
  it('carries the entered values through unchanged', () => {
    expect(resolveAdHocJobSpec(launch({ instanceType: 'm7i.4xlarge' }))).toMatchObject({
      workflowType: 'delegated',
      model: 'claude-opus-5',
      instanceType: 'm7i.4xlarge',
      purchaseMode: 'spot',
    })
  })

  it('reads an absent cap and an explicitly null one as the same thing', () => {
    expect(resolveAdHocJobSpec(launch())).toMatchObject({ turnCap: null, spendCap: null })
    expect(resolveAdHocJobSpec(launch({ turnCap: null, spendCap: null }))).toMatchObject({
      turnCap: null,
      spendCap: null,
    })
  })

  it('keeps the spend cap a decimal string all the way through', () => {
    expect(resolveAdHocJobSpec(launch({ spendCap: '25.5000', turnCap: 40 }))).toMatchObject({
      spendCap: '25.5000',
      turnCap: 40,
    })
  })

  it('lets a delegated run go uncapped — a human is watching it', () => {
    expect(() => resolveAdHocJobSpec(launch({ workflowType: 'delegated' }))).not.toThrow()
  })

  it('refuses an autonomous run with neither cap (FR-055)', () => {
    expect(() => resolveAdHocJobSpec(launch({ workflowType: 'autonomous' }))).toThrow(
      /both a turn cap and a spend cap/,
    )
  })

  it('refuses an autonomous run with only one cap, either way round (FR-055)', () => {
    expect(() => resolveAdHocJobSpec(launch({ workflowType: 'autonomous', turnCap: 40 }))).toThrow()
    expect(() =>
      resolveAdHocJobSpec(launch({ workflowType: 'autonomous', spendCap: '25.0000' })),
    ).toThrow()
  })

  it('admits an autonomous run carrying both (FR-055)', () => {
    expect(
      resolveAdHocJobSpec(launch({ workflowType: 'autonomous', turnCap: 40, spendCap: '25.0000' })),
    ).toMatchObject({ workflowType: 'autonomous', turnCap: 40, spendCap: '25.0000' })
  })

  it('refuses with BAD_REQUEST, because the request is wrong rather than the caller', () => {
    expect(() => resolveAdHocJobSpec(launch({ workflowType: 'autonomous' }))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }) as Error,
    )
  })
})

describe('deriveSubdirectory', () => {
  it('takes the repository name out of every remote form the schema admits', () => {
    expect(deriveSubdirectory('https://github.com/org/sisyphus.git')).toBe('sisyphus')
    expect(deriveSubdirectory('http://git.internal/org/sisyphus')).toBe('sisyphus')
    expect(deriveSubdirectory('ssh://git@git.internal:2222/org/sisyphus.git')).toBe('sisyphus')
    expect(deriveSubdirectory('git@github.com:org/sisyphus.git')).toBe('sisyphus')
  })

  it('ignores a trailing slash and a mixed-case suffix', () => {
    expect(deriveSubdirectory('https://github.com/org/sisyphus.GIT/')).toBe('sisyphus')
  })

  it('reduces anything a path cannot hold to a hyphen', () => {
    expect(deriveSubdirectory('https://github.com/org/my repo!!')).toBe('my-repo')
  })

  it('never answers with a blank directory name', () => {
    expect(deriveSubdirectory('https://github.com/org/---')).toBe('repository')
    expect(deriveSubdirectory('https://github.com/org/___')).toBe('repository')
  })

  it('never answers with a traversal, whatever was pasted (FR-111)', () => {
    expect(deriveSubdirectory('https://github.com/org/..')).toBe('repository')
    expect(deriveSubdirectory('https://github.com/org/.')).toBe('repository')
    expect(deriveSubdirectory('https://github.com/org/../../etc')).toBe('etc')
  })

  it('falls back to the segment above rather than inventing one, for a trailing slash', () => {
    expect(deriveSubdirectory('https://github.com/org/')).toBe('org')
  })
})

describe('adHocWorkspaceName', () => {
  it('says what the row is, so it reads as a by-product rather than as curation', () => {
    expect(adHocWorkspaceName('git@github.com:org/sisyphus.git', WORKSPACE_ID)).toBe(
      `ad hoc: sisyphus (${WORKSPACE_ID})`,
    )
  })

  it('folds in the id, so two launches on one repository cannot collide on the unique name', () => {
    const first = adHocWorkspaceName('git@github.com:org/sisyphus.git', WORKSPACE_ID)
    const second = adHocWorkspaceName(
      'git@github.com:org/sisyphus.git',
      '01890a5d-ac96-774b-bcce-b302099a8058',
    )

    expect(first).not.toBe(second)
  })
})

describe('willSaveAsProfile', () => {
  it('is the naming and nothing else — there is no second control to disagree with it', () => {
    expect(willSaveAsProfile(undefined)).toBe(false)
    expect(willSaveAsProfile({ name: 'Nightly maintenance' })).toBe(true)
  })
})
