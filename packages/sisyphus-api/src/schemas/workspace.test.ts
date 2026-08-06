import { describe, expect, it } from 'vitest'

import {
  cloneWorkspaceInput,
  createWorkspaceInput,
  listWorkspacesInput,
  setWorkspaceEnabledInput,
  updateWorkspaceInput,
  workspaceEntryInput,
  workspaceEntryListInput,
} from './workspace'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const entry = (overrides: Record<string, unknown> = {}) => ({
  repositoryUrl: 'https://github.com/example/api',
  baseBranch: 'main',
  subdirectory: 'api',
  isPrimary: true,
  position: 0,
  ...overrides,
})

describe('workspaceEntryInput', () => {
  it('requires a repository, a base branch and a subdirectory', () => {
    expect(workspaceEntryInput.parse(entry())).toMatchObject({ subdirectory: 'api' })
    expect(workspaceEntryInput.safeParse({ ...entry(), baseBranch: '' }).success).toBe(false)
  })

  it('is not primary unless it says so', () => {
    const withoutFlag: Record<string, unknown> = entry()
    Reflect.deleteProperty(withoutFlag, 'isPrimary')

    expect(workspaceEntryInput.parse(withoutFlag).isPrimary).toBe(false)
  })
})

describe('workspaceEntryListInput', () => {
  it('requires exactly one primary entry (FR-110)', () => {
    expect(workspaceEntryListInput.safeParse([entry({ isPrimary: false })]).success).toBe(false)
    expect(
      workspaceEntryListInput.safeParse([
        entry(),
        entry({ subdirectory: 'web', position: 1, isPrimary: true }),
      ]).success,
    ).toBe(false)
    expect(
      workspaceEntryListInput.safeParse([
        entry(),
        entry({ subdirectory: 'web', position: 1, isPrimary: false }),
      ]).success,
    ).toBe(true)
  })

  it('refuses two entries checking out into the same subdirectory (FR-111)', () => {
    expect(
      workspaceEntryListInput.safeParse([entry(), entry({ position: 1, isPrimary: false })])
        .success,
    ).toBe(false)
  })

  it('refuses an empty workspace', () => {
    expect(workspaceEntryListInput.safeParse([]).success).toBe(false)
  })
})

describe('createWorkspaceInput', () => {
  it('takes the whole entry list rather than a patch — an edit creates a version (FR-125)', () => {
    expect(createWorkspaceInput.parse({ name: 'alpha', entries: [entry()] }).entries).toHaveLength(
      1,
    )
  })
})

describe('updateWorkspaceInput', () => {
  it('also submits the whole list, so the new version is complete on its own', () => {
    expect(Object.keys(updateWorkspaceInput.shape)).toContain('entries')
    expect(updateWorkspaceInput.safeParse({ workspaceId: ID }).success).toBe(false)
  })
})

describe('cloneWorkspaceInput and setWorkspaceEnabledInput', () => {
  it('take exactly what they need (FR-127)', () => {
    expect(cloneWorkspaceInput.parse({ workspaceId: ID, name: 'alpha-copy' })).toStrictEqual({
      workspaceId: ID,
      name: 'alpha-copy',
    })
    expect(setWorkspaceEnabledInput.parse({ workspaceId: ID, enabled: false })).toStrictEqual({
      workspaceId: ID,
      enabled: false,
    })
  })
})

describe('listWorkspacesInput', () => {
  it('hides archived rows unless asked (FR-128)', () => {
    expect(listWorkspacesInput.parse({}).includeArchived).toBe(false)
  })
})
