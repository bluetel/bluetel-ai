import { UNEXPECTED_ERROR } from '@sisyphus-admin/components/admin'
import { describe, expect, it } from 'vitest'

import type { PublishedWorkspaceResult, WorkspaceEnableResult } from './workspace-outcome'
import {
  describeWorkspaceEnable,
  describeWorkspaceError,
  describeWorkspacePublish,
} from './workspace-outcome'

const published = (version: number, entries = 2): PublishedWorkspaceResult =>
  ({
    workspace: { id: 'workspace-1', name: 'Payments' },
    published: {
      version: { id: 'version-4', version },
      entries: Array.from({ length: entries }, (_, index) => ({ id: `entry-${String(index)}` })),
    },
  }) as unknown as PublishedWorkspaceResult

const enableResult = (enabled: boolean): WorkspaceEnableResult =>
  ({ id: 'workspace-1', name: 'Payments', enabled }) as unknown as WorkspaceEnableResult

describe('describeWorkspacePublish (FR-125)', () => {
  it('names the version, because that is what an edit produced', () => {
    expect(describeWorkspacePublish(published(4), 'edited').readout).toBe('v4 published')
  })

  it('says in words that a run in flight is unaffected, so “saved” cannot be inferred', () => {
    expect(describeWorkspacePublish(published(4), 'edited').detail).toContain(
      'runs in flight stay on the version they started with',
    )
  })

  it('says a new workspace arrives disabled, so that reads as design rather than as a bug', () => {
    expect(describeWorkspacePublish(published(1), 'created').detail).toContain('disabled')
  })

  it('does not claim a creation left anything running unchanged — nothing was running on it', () => {
    expect(describeWorkspacePublish(published(1), 'created').detail).not.toContain('in flight')
  })

  it('counts one repository as one rather than as 1 repositories', () => {
    expect(describeWorkspacePublish(published(1, 1), 'created').detail).toContain('1 repository')
  })
})

describe('describeWorkspaceEnable (FR-128)', () => {
  it('says disabling never interrupts a run, which is why it replaces deletion', () => {
    expect(describeWorkspaceEnable(enableResult(false)).detail).toContain(
      'Runs already in flight against it are unaffected',
    )
  })

  it('reports an enable as a state the chip can read', () => {
    expect(describeWorkspaceEnable(enableResult(true)).readout).toBe('enabled')
  })
})

describe('describeWorkspaceError', () => {
  it('says nothing was published on a conflict, which is what decides whether to retry', () => {
    expect(describeWorkspaceError({ data: { code: 'CONFLICT' } })).toEqual({
      code: 'E_WORKSPACE_REFUSED',
      action: 'Nothing was published. Read the refusal, change what it names, and try again.',
    })
  })

  it('falls through to the shared mapping for anything it has no opinion about', () => {
    expect(describeWorkspaceError({ data: { code: 'UNAUTHORIZED' } }).code).toBe('E_NOT_SIGNED_IN')
  })

  it('never produces a dead end', () => {
    expect(describeWorkspaceError('something odd')).toStrictEqual(UNEXPECTED_ERROR)
  })
})
