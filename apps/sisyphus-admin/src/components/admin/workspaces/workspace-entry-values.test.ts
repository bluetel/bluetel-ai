import { describe, expect, it } from 'vitest'

import type { WorkspaceDraft } from './workspace-entry-values'
import {
  draftFromVersion,
  EMPTY_ENTRY,
  EMPTY_WORKSPACE,
  toCreateWorkspaceInput,
  toUpdateWorkspaceInput,
  withoutEntryAt,
  withPrimaryAt,
  workspaceFieldCode,
} from './workspace-entry-values'

const WORKSPACE_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

const filled = (overrides: Partial<WorkspaceDraft> = {}): WorkspaceDraft => ({
  name: 'Payments',
  description: '',
  entries: [
    {
      repositoryUrl: 'git@host:acme/api.git',
      baseBranch: 'main',
      subdirectory: 'api',
      isPrimary: true,
    },
  ],
  ...overrides,
})

describe('EMPTY_WORKSPACE', () => {
  it('starts with one repository already marked primary, because a version needs exactly one', () => {
    expect(EMPTY_WORKSPACE.entries).toHaveLength(1)
    expect(EMPTY_WORKSPACE.entries[0]?.isPrimary).toBe(true)
  })
})

describe('withPrimaryAt (FR-110)', () => {
  it('moves the role rather than adding one, so two primaries cannot be expressed', () => {
    const entries = [
      { ...EMPTY_ENTRY, isPrimary: true },
      { ...EMPTY_ENTRY, isPrimary: false },
    ]

    expect(withPrimaryAt(entries, 1).map((entry) => entry.isPrimary)).toEqual([false, true])
  })
})

describe('withoutEntryAt (FR-110)', () => {
  it('removes the row it names', () => {
    const entries = [
      { ...EMPTY_ENTRY, subdirectory: 'api', isPrimary: true },
      { ...EMPTY_ENTRY, subdirectory: 'web' },
    ]

    expect(withoutEntryAt(entries, 1).map((entry) => entry.subdirectory)).toEqual(['api'])
  })

  it('promotes the first survivor when the primary was removed, rather than leaving none', () => {
    const entries = [
      { ...EMPTY_ENTRY, subdirectory: 'api', isPrimary: true },
      { ...EMPTY_ENTRY, subdirectory: 'web' },
    ]

    expect(withoutEntryAt(entries, 0)).toEqual([
      { ...EMPTY_ENTRY, subdirectory: 'web', isPrimary: true },
    ])
  })

  it('leaves an empty list empty rather than inventing a primary', () => {
    expect(withoutEntryAt([{ ...EMPTY_ENTRY, isPrimary: true }], 0)).toEqual([])
  })
})

describe('draftFromVersion (FR-125)', () => {
  it('loads the published entries, so an edit starts from what exists', () => {
    const draft = draftFromVersion({
      name: 'Payments',
      description: null,
      entries: [
        {
          id: 'entry-1',
          repositoryUrl: 'git@host:acme/api.git',
          baseBranch: 'main',
          subdirectory: 'api',
          role: 'primary',
        },
      ],
    })

    expect(draft).toEqual({
      name: 'Payments',
      description: '',
      entries: [
        {
          repositoryUrl: 'git@host:acme/api.git',
          baseBranch: 'main',
          subdirectory: 'api',
          isPrimary: true,
        },
      ],
    })
  })
})

describe('toCreateWorkspaceInput', () => {
  it('derives position from the row order rather than asking anyone to type it', () => {
    const submission = toCreateWorkspaceInput(
      filled({
        entries: [
          {
            repositoryUrl: 'git@host:a.git',
            baseBranch: 'main',
            subdirectory: 'a',
            isPrimary: true,
          },
          {
            repositoryUrl: 'git@host:b.git',
            baseBranch: 'main',
            subdirectory: 'b',
            isPrimary: false,
          },
        ],
      }),
    )

    expect(submission.ok && submission.input.entries.map((entry) => entry.position)).toEqual([0, 1])
  })

  it('sends a blank description as absent, not as an empty string', () => {
    const submission = toCreateWorkspaceInput(filled())

    expect(submission.ok && submission.input.description).toBeUndefined()
  })

  it('refuses a missing name, pointing at the name field', () => {
    const submission = toCreateWorkspaceInput(filled({ name: '  ' }))

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.name?.code).toBe('E_WORKSPACE_NAME')
  })

  it('marks the offending row rather than the whole list when one repository is incomplete', () => {
    const submission = toCreateWorkspaceInput(
      filled({
        entries: [
          {
            repositoryUrl: 'git@host:a.git',
            baseBranch: 'main',
            subdirectory: 'a',
            isPrimary: true,
          },
          { repositoryUrl: '', baseBranch: '', subdirectory: '', isPrimary: false },
        ],
      }),
    )

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.rows?.[1]).toBeDefined()
    expect(!submission.ok && submission.errors.rows?.[0]).toBeUndefined()
  })

  it('refuses two primaries with the rule’s own next action (FR-110)', () => {
    const submission = toCreateWorkspaceInput(
      filled({
        entries: [
          {
            repositoryUrl: 'git@host:a.git',
            baseBranch: 'main',
            subdirectory: 'a',
            isPrimary: true,
          },
          {
            repositoryUrl: 'git@host:b.git',
            baseBranch: 'main',
            subdirectory: 'b',
            isPrimary: true,
          },
        ],
      }),
    )

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.entries?.action).toContain('exactly one')
  })

  it('refuses two repositories checking out over each other (FR-111)', () => {
    const submission = toCreateWorkspaceInput(
      filled({
        entries: [
          {
            repositoryUrl: 'git@host:a.git',
            baseBranch: 'main',
            subdirectory: 'a',
            isPrimary: true,
          },
          {
            repositoryUrl: 'git@host:b.git',
            baseBranch: 'main',
            subdirectory: 'a',
            isPrimary: false,
          },
        ],
      }),
    )

    expect(submission.ok).toBe(false)
    expect(!submission.ok && submission.errors.entries?.action).toContain('own subdirectory')
  })
})

describe('toUpdateWorkspaceInput (FR-125)', () => {
  it('is the create submission addressed to an existing workspace, and nothing else', () => {
    const created = toCreateWorkspaceInput(filled())
    const updated = toUpdateWorkspaceInput(WORKSPACE_ID, filled())

    if (!created.ok || !updated.ok) throw new Error('both submissions should have been accepted')

    expect(updated.input.entries).toEqual(created.input.entries)
    expect(updated.input.workspaceId).toBe(WORKSPACE_ID)
  })

  it('refuses exactly what the create submission refuses', () => {
    const updated = toUpdateWorkspaceInput(WORKSPACE_ID, filled({ name: '' }))

    expect(updated.ok).toBe(false)
  })
})

describe('workspaceFieldCode', () => {
  it('produces a searchable, quotable code per field', () => {
    expect(workspaceFieldCode('entries')).toBe('E_WORKSPACE_ENTRIES')
    expect(workspaceFieldCode('name')).toBe('E_WORKSPACE_NAME')
  })
})
