import { describe, expect, it } from 'vitest'

import type { WorkspaceListItem } from './workspace-listing'
import {
  ABSENT,
  toWorkspaceReadouts,
  workspaceStateReadout,
  workspaceVersionReadout,
} from './workspace-listing'

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'entry-1',
  workspaceVersionId: 'version-3',
  repositoryUrl: 'git@host:acme/api.git',
  baseBranch: 'main',
  subdirectory: 'api',
  isPrimary: true,
  position: 0,
  ...overrides,
})

const workspace = (overrides: Partial<WorkspaceListItem> = {}): WorkspaceListItem =>
  ({
    id: 'workspace-1',
    name: 'Payments',
    description: 'The payments repositories',
    enabled: true,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    versionCount: 7,
    currentVersion: {
      id: 'version-3',
      workspaceId: 'workspace-1',
      version: 3,
      createdByUserId: 'user-1',
      createdAt: new Date('2026-02-01T09:30:00Z'),
      entries: [entry(), entry({ id: 'entry-2', subdirectory: 'web', isPrimary: false })],
    },
    ...overrides,
  }) as WorkspaceListItem

describe('workspaceStateReadout (FR-128)', () => {
  it('reads an enabled workspace as enabled', () => {
    expect(workspaceStateReadout(workspace())).toBe('enabled')
  })

  it('reads a disabled one as disabled, because disabling is what replaces deletion', () => {
    expect(workspaceStateReadout(workspace({ enabled: false }))).toBe('disabled')
  })

  it('lets archived win, because it is the state that forbids editing', () => {
    expect(workspaceStateReadout(workspace({ archivedAt: new Date(), enabled: true }))).toBe(
      'archived',
    )
  })
})

describe('workspaceVersionReadout (FR-125)', () => {
  it('says which version is pinned and how many exist, so an edit is visible afterwards', () => {
    expect(workspaceVersionReadout(workspace())).toBe('v3 of 7')
  })

  it('says so plainly when nothing has been published', () => {
    expect(workspaceVersionReadout(workspace({ currentVersion: undefined }))).toBe('none published')
  })
})

describe('toWorkspaceReadouts', () => {
  it('leads with the version rather than with the repository list', () => {
    expect(toWorkspaceReadouts(workspace()).version).toBe('v3 of 7')
  })

  it('carries the version id, which is what a run records and a support question quotes', () => {
    expect(toWorkspaceReadouts(workspace()).currentVersionId).toBe('version-3')
  })

  it('says which entry is primary out loud, because exactly one must be (FR-110)', () => {
    const roles = toWorkspaceReadouts(workspace()).entries.map((row) => row.role)

    expect(roles).toEqual(['primary', 'secondary'])
  })

  it('reads an absent description as absent rather than as an empty readout', () => {
    expect(toWorkspaceReadouts(workspace({ description: null })).description).toBe(ABSENT)
  })

  it('refuses to offer an edit on an archived workspace, which the router would refuse', () => {
    expect(toWorkspaceReadouts(workspace({ archivedAt: new Date() })).editable).toBe(false)
  })

  it('counts the repositories in the pinned version, not across every version', () => {
    expect(toWorkspaceReadouts(workspace()).entryCount).toBe('2')
  })
})
