import { describe, expect, it } from 'vitest'

import * as workspaces from './index'

describe('the workspace admin barrel', () => {
  it('exposes the screen, its parts and its pure modules, so nothing imports an internal', () => {
    for (const name of [
      'WorkspacesPanel',
      'WorkspaceCard',
      'WorkspaceEditor',
      'WorkspaceEntryFields',
      'EMPTY_WORKSPACE',
      'draftFromVersion',
      'toCreateWorkspaceInput',
      'toUpdateWorkspaceInput',
      'withPrimaryAt',
      'withoutEntryAt',
      'toWorkspaceReadouts',
      'workspaceVersionReadout',
      'describeWorkspacePublish',
      'describeWorkspaceEnable',
      'describeWorkspaceError',
    ]) {
      expect(workspaces).toHaveProperty(name)
    }
  })

  it('exports no primitive of its own — the panel has one primitive set (FR-033)', () => {
    expect(workspaces).not.toHaveProperty('Button')
    expect(workspaces).not.toHaveProperty('Field')
    expect(workspaces).not.toHaveProperty('Card')
  })
})
