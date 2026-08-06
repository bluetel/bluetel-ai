import { UNEXPECTED_ERROR } from '@sisyphus-admin/components/admin'
import { describe, expect, it } from 'vitest'

import type {
  ProfileEnableResult,
  ProfileReferencesResult,
  PublishedProfileResult,
} from './profile-outcome'
import {
  describeProfileEnable,
  describeProfileError,
  describeProfilePublish,
  describeProfileReferences,
} from './profile-outcome'

const published = (version: number): PublishedProfileResult =>
  ({
    profile: { id: 'profile-1', name: 'Payments' },
    version: { id: 'version-4', version },
  }) as PublishedProfileResult

const enableResult = (enabled: boolean): ProfileEnableResult =>
  ({
    profile: { id: 'profile-1', name: 'Payments', enabled },
    check: undefined,
  }) as ProfileEnableResult

describe('describeProfilePublish (FR-124, FR-125)', () => {
  it('names the version, because that is what an edit produced', () => {
    expect(describeProfilePublish(published(4), 'edited').readout).toBe('v4 published')
  })

  it('says in words that a run in flight is unaffected, so “saved” cannot be inferred', () => {
    expect(describeProfilePublish(published(4), 'edited').detail).toContain(
      'runs in flight stay on the version they started with',
    )
  })

  it('says a new profile arrives disabled and granted to nobody, which is FR-124 not a bug', () => {
    expect(describeProfilePublish(published(1), 'created').detail).toContain(
      'disabled and granted to nobody',
    )
  })

  it('says the same of a clone, because access is granted rather than inherited', () => {
    expect(describeProfilePublish(published(1), 'cloned').detail).toContain(
      'disabled and granted to nobody',
    )
  })
})

describe('describeProfileEnable (FR-124, FR-128)', () => {
  it('reports the check that ran, not just the flag that flipped', () => {
    expect(describeProfileEnable(enableResult(true)).detail).toContain('every repository')
  })

  it('says disabling never interrupts a run, which is why it replaces deletion', () => {
    expect(describeProfileEnable(enableResult(false)).detail).toContain(
      'Runs already in flight are unaffected',
    )
  })
})

describe('describeProfileReferences (FR-128)', () => {
  it('says what still points at the profile and whether it may be archived', () => {
    const references = {
      integrations: [{ integrationId: 'i-1', name: 'Jira' }],
      activeWorkflowCount: 2,
      totalWorkflowCount: 40,
      liveGrantCount: 1,
      archivable: false,
    } as unknown as ProfileReferencesResult

    const sentence = describeProfileReferences(references)

    expect(sentence).toContain('1 live grant')
    expect(sentence).toContain('1 integration')
    expect(sentence).toContain('2 of 40 runs still non-terminal')
    expect(sentence).toContain('may only be disabled')
  })
})

describe('describeProfileError', () => {
  it('says nothing was published on a conflict, which is what decides whether to retry', () => {
    expect(describeProfileError({ data: { code: 'CONFLICT' } }).code).toBe('E_PROFILE_REFUSED')
  })

  it('never produces a dead end', () => {
    expect(describeProfileError('something odd')).toStrictEqual(UNEXPECTED_ERROR)
  })
})
