import { describe, expect, it } from 'vitest'

import {
  discoverSessionIds,
  mangleWorkspacePath,
  parseConversationLog,
  runRestoreSpike,
  sessionLogDirectory,
} from './spike-restore'

describe('mangleWorkspacePath', () => {
  it('replaces path separators, which is what makes the pinned root portable', () => {
    expect(mangleWorkspacePath('/workspace')).toBe('-workspace')
    expect(mangleWorkspacePath('/workspace/primary')).toBe('-workspace-primary')
  })

  it('produces the same name for the same absolute path every time', () => {
    expect(mangleWorkspacePath('/workspace')).toBe(mangleWorkspacePath('/workspace'))
  })

  it('produces different names for different absolute paths — the trap R2 avoids', () => {
    expect(mangleWorkspacePath('/workspace')).not.toBe(mangleWorkspacePath('/home/runner/work'))
  })
})

describe('sessionLogDirectory', () => {
  it('derives the log directory from the config directory and the pinned root', () => {
    expect(sessionLogDirectory('/workspace/.agent-config', '/workspace')).toBe(
      '/workspace/.agent-config/projects/-workspace',
    )
  })
})

describe('parseConversationLog', () => {
  it('discards a truncated trailing line and says so (FR-053)', () => {
    const log = ['{"sequence":0}', '{"sequence":1}', '{"sequence":2,"content":[{"ty'].join('\n')
    const parsed = parseConversationLog(log)

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.truncationRepaired).toBe(true)
    expect(parsed.linesRead).toBe(3)
  })

  it('reports no repair when nothing was truncated', () => {
    const parsed = parseConversationLog('{"sequence":0}\n{"sequence":1}\n')

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.truncationRepaired).toBe(false)
  })

  it('refuses a break in the middle, which is corruption rather than truncation', () => {
    const log = ['{"sequence":0}', 'not json at all', '{"sequence":2}'].join('\n')

    expect(() => parseConversationLog(log)).toThrow(/line 2 of 3/)
  })

  it('handles an empty log', () => {
    const parsed = parseConversationLog('')

    expect(parsed.entries).toHaveLength(0)
    expect(parsed.truncationRepaired).toBe(false)
  })
})

describe('discoverSessionIds', () => {
  it('returns nothing for a directory that does not exist', async () => {
    await expect(discoverSessionIds('/nowhere/at/all/projects')).resolves.toEqual([])
  })
})

describe('spike S2 — cross-instance snapshot restore', () => {
  it('restores uncommitted work, a findable session, and a repaired log', async () => {
    const outcome = await runRestoreSpike({ sessionId: 'abc-123', intactEntryCount: 5 })

    // The pinned root really was gone between the two simulated instances,
    // so instance B read the archive rather than instance A's leftovers.
    expect(outcome.rootDestroyedBetweenInstances).toBe(true)
    expect(outcome.archiveBytes).toBeGreaterThan(0)

    // `--resume <id>` has something to find at the pinned path.
    expect(outcome.sessionIdsFoundOnB).toEqual(['abc-123'])
    expect(outcome.mangledDirectoryName).not.toContain('/')

    // The work the snapshot exists to preserve.
    expect(outcome.committedFilePresent).toBe(true)
    expect(outcome.modifiedFileContentsOnB).toContain('never committed')
    expect(outcome.untrackedFilePresentOnB).toBe(true)

    // `.git` came across, so the working tree is still a repository that
    // knows it has been modified — not just a bag of files.
    expect(outcome.gitStatusOnB).toContain('M tracked.txt')
    expect(outcome.gitStatusOnB).toContain('?? scratch-notes.md')

    // The truncated trailing line was dropped, not fatal.
    expect(outcome.conversationLinesOnA).toBe(6)
    expect(outcome.conversationEntriesOnB).toBe(5)
    expect(outcome.truncationRepaired).toBe(true)
  }, 60_000)

  it('keeps credential material out of the archive (FR-072)', async () => {
    const outcome = await runRestoreSpike()

    expect(outcome.credentialExcludedFromArchive).toBe(true)
  }, 60_000)

  it('records which compression was actually used rather than assuming zstd', async () => {
    const outcome = await runRestoreSpike()

    expect(['zstd', 'none']).toContain(outcome.compression)
  }, 60_000)
})
