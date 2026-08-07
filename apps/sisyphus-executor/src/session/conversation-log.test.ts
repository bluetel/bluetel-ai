import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  discoverSessionIds,
  mangleWorkspacePath,
  parseConversationLog,
  sessionLogDirectory,
} from './conversation-log'

/**
 * The promoted half of spike S2. `spike-restore.test.ts` still exercises these through the harness;
 * what is asserted here is the behaviour the **restore path** depends on, stated against the module
 * restore actually imports.
 */

describe('mangleWorkspacePath', () => {
  it('is stable for one absolute path, which is what makes a restore findable (R2)', () => {
    expect(mangleWorkspacePath('/workspace')).toBe('-workspace')
    expect(mangleWorkspacePath('/workspace')).toBe(mangleWorkspacePath('/workspace'))
  })

  it('differs for a different absolute path — the trap the pinned root avoids', () => {
    expect(mangleWorkspacePath('/workspace')).not.toBe(mangleWorkspacePath('/home/runner/work'))
  })
})

describe('sessionLogDirectory', () => {
  it('derives the log directory from the relocated config directory and the pinned root', () => {
    expect(sessionLogDirectory('/workspace/.agent-config', '/workspace')).toBe(
      '/workspace/.agent-config/projects/-workspace',
    )
  })
})

describe('parseConversationLog', () => {
  it('treats a truncated final line as a normal path, not an error (FR-053)', () => {
    const parsed = parseConversationLog('{"sequence":0}\n{"sequence":1}\n{"seq')

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.truncationRepaired).toBe(true)
    expect(parsed.linesRead).toBe(3)
  })

  it('reports no repair when every line parses', () => {
    const parsed = parseConversationLog('{"sequence":0}\n{"sequence":1}\n')

    expect(parsed.entries).toHaveLength(2)
    expect(parsed.truncationRepaired).toBe(false)
  })

  it('still throws for a bad line in the middle — that is corruption, not truncation', () => {
    expect(() => parseConversationLog('{"a":1}\nnot json\n{"c":3}')).toThrow(/line 2 of 3/)
  })

  it('accepts an empty log rather than treating it as damaged', () => {
    const parsed = parseConversationLog('')

    expect(parsed.entries).toStrictEqual([])
    expect(parsed.truncationRepaired).toBe(false)
  })
})

describe('discoverSessionIds', () => {
  it('answers with nothing when the directory does not exist', async () => {
    await expect(discoverSessionIds('/nowhere/at/all/projects')).resolves.toStrictEqual([])
  })

  it('lists the session ids stored at the pinned path, ignoring anything else', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'sisyphus-conversation-log-'))
    const logs = join(scratch, 'projects', '-workspace')

    await mkdir(logs, { recursive: true })
    await writeFile(join(logs, 'bbb.jsonl'), '{}\n')
    await writeFile(join(logs, 'aaa.jsonl'), '{}\n')
    await writeFile(join(logs, 'notes.txt'), 'not a session')

    await expect(discoverSessionIds(logs)).resolves.toStrictEqual(['aaa', 'bbb'])
  })
})
