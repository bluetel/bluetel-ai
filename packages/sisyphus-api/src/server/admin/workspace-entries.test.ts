import { describe, expect, it } from 'vitest'

import type { WorkspaceEntryInput } from '../../schemas'

import {
  describeSubdirectoryRejection,
  describeWorkspaceEntry,
  normaliseSubdirectory,
  normaliseWorkspaceEntries,
  SUBDIRECTORY_REJECTIONS,
} from './workspace-entries'

const entry = (overrides: Partial<WorkspaceEntryInput> = {}): WorkspaceEntryInput => ({
  repositoryUrl: 'github.com/acme/api',
  baseBranch: 'main',
  subdirectory: 'api',
  isPrimary: true,
  position: 1,
  ...overrides,
})

describe('normaliseSubdirectory', () => {
  it('reduces a path to the form that is stored', () => {
    expect(normaliseSubdirectory('services/api')).toStrictEqual({
      outcome: 'accepted',
      subdirectory: 'services/api',
    })
  })

  it('treats the several spellings of one directory as one directory', () => {
    // The unique index is on text. If these three reached it as written, two entries would agree
    // on a checkout path and disagree with the constraint meant to prevent exactly that (FR-111).
    const spellings = ['services/api/', './services/api', 'services//api']

    for (const spelling of spellings) {
      expect(normaliseSubdirectory(spelling)).toStrictEqual({
        outcome: 'accepted',
        subdirectory: 'services/api',
      })
    }
  })

  it('resolves an interior `..` rather than refusing a path that stays inside the root', () => {
    expect(normaliseSubdirectory('services/api/../web')).toStrictEqual({
      outcome: 'accepted',
      subdirectory: 'services/web',
    })
  })

  it('refuses a path that climbs above the root, however it is spelled (FR-111)', () => {
    for (const escape of ['..', '../elsewhere', 'services/../../elsewhere', './../x']) {
      expect(normaliseSubdirectory(escape)).toStrictEqual({
        outcome: 'rejected',
        reason: 'escapes_root',
      })
    }
  })

  it('refuses an absolute path and a drive letter', () => {
    expect(normaliseSubdirectory('/etc')).toStrictEqual({ outcome: 'rejected', reason: 'absolute' })
    expect(normaliseSubdirectory('C:/repos')).toStrictEqual({
      outcome: 'rejected',
      reason: 'absolute',
    })
  })

  it('refuses a backslash rather than guessing it was a separator', () => {
    expect(normaliseSubdirectory('services\\api')).toStrictEqual({
      outcome: 'rejected',
      reason: 'backslash',
    })
  })

  it('refuses a control character and a shell-expanded tilde', () => {
    const newline = String.fromCodePoint(10)

    expect(normaliseSubdirectory(`api${newline}rm -rf /`)).toStrictEqual({
      outcome: 'rejected',
      reason: 'unsafe_character',
    })
    expect(normaliseSubdirectory('~/secrets')).toStrictEqual({
      outcome: 'rejected',
      reason: 'unsafe_character',
    })
  })

  it('refuses a path that names nothing once separators are removed', () => {
    expect(normaliseSubdirectory('./')).toStrictEqual({ outcome: 'rejected', reason: 'empty' })
  })

  it('has a message for every rejection reason', () => {
    for (const reason of SUBDIRECTORY_REJECTIONS) {
      expect(describeSubdirectoryRejection(reason).length).toBeGreaterThan(0)
    }
  })
})

describe('describeWorkspaceEntry', () => {
  it('names the repository and branch so an admin knows which row to fix', () => {
    expect(
      describeWorkspaceEntry(2, { repositoryUrl: 'github.com/acme/api', baseBranch: 'main' }),
    ).toBe('workspace entry 2 (github.com/acme/api on main)')
  })
})

describe('normaliseWorkspaceEntries', () => {
  it('returns entries in position order with subdirectories in stored form', () => {
    const normalised = normaliseWorkspaceEntries([
      entry({ subdirectory: 'web/', isPrimary: false, position: 2 }),
      entry({ subdirectory: './api', isPrimary: true, position: 1 }),
    ])

    expect(normalised.map((item) => item.subdirectory)).toStrictEqual(['api', 'web'])
  })

  it('refuses an empty list', () => {
    expect(() => normaliseWorkspaceEntries([])).toThrow(/at least one repository/)
  })

  it('refuses two entries that normalise onto the same directory, naming both (FR-111)', () => {
    expect(() =>
      normaliseWorkspaceEntries([
        entry({ subdirectory: 'services/api', position: 1 }),
        entry({ subdirectory: 'services/api/', isPrimary: false, position: 2 }),
      ]),
    ).toThrow(/workspace entry 2 .* already uses/)
  })

  it('refuses a repeated position rather than surfacing a unique-index violation', () => {
    expect(() =>
      normaliseWorkspaceEntries([
        entry({ subdirectory: 'api', position: 1 }),
        entry({ subdirectory: 'web', isPrimary: false, position: 1 }),
      ]),
    ).toThrow(/both claim position 1/)
  })

  it('names the offending entry when its subdirectory escapes the root', () => {
    expect(() =>
      normaliseWorkspaceEntries([
        entry({ subdirectory: 'api', position: 1 }),
        entry({ subdirectory: '../elsewhere', isPrimary: false, position: 2 }),
      ]),
    ).toThrow(/workspace entry 2 \(github.com\/acme\/api on main\) climbs above the workspace root/)
  })

  it('refuses no primary and refuses two, saying how many there were (FR-110)', () => {
    expect(() =>
      normaliseWorkspaceEntries([entry({ isPrimary: false, subdirectory: 'api' })]),
    ).toThrow(/Exactly one entry must be primary; this workspace has 0/)

    expect(() =>
      normaliseWorkspaceEntries([
        entry({ subdirectory: 'api', position: 1 }),
        entry({ subdirectory: 'web', position: 2 }),
      ]),
    ).toThrow(/this workspace has 2/)
  })

  it('is BAD_REQUEST, not FORBIDDEN — the admin may act, the submission is wrong', () => {
    expect(() => normaliseWorkspaceEntries([])).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})
