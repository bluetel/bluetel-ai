import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  archiveAnchorDirectory,
  archiveMemberName,
  listArchiveMembers,
  packWorkspaceArchive,
  SnapshotArchiveError,
  unpackWorkspaceArchive,
} from './snapshot-archive'

/**
 * The archive mechanics, on their own.
 *
 * The claim that matters is the one R2 rests on: packing from the pinned root's **parent** with the
 * root as a single member means an extract at that parent puts the tree back on the identical
 * absolute path. Everything else here — the compression round trip, the exclusion reaching `tar` at
 * all, the failure naming its tool — exists so `snapshot.ts` and `restore.ts` can be about
 * snapshots rather than about `tar`.
 */

const scratches: string[] = []

const scratch = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'sisyphus-archive-'))

  scratches.push(path)

  return path
}

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('archiveMemberName', () => {
  it('is relative and parent-anchored, so the extract does not depend on slash stripping', () => {
    expect(archiveMemberName('/workspace')).toBe('./workspace')
    expect(archiveMemberName('/srv/run/workspace')).toBe('./workspace')
  })
})

describe('archiveAnchorDirectory', () => {
  it('is the pinned root’s parent, so the root lands back on itself', () => {
    expect(archiveAnchorDirectory('/workspace')).toBe('/')
    expect(archiveAnchorDirectory('/srv/run/workspace')).toBe('/srv/run')
  })
})

describe('packWorkspaceArchive and unpackWorkspaceArchive', () => {
  const buildRoot = async (): Promise<{ readonly base: string; readonly root: string }> => {
    const base = await scratch()
    const root = join(base, 'workspace')

    await mkdir(join(root, 'primary', 'src'), { recursive: true })
    await writeFile(join(root, 'primary', 'src', 'main.ts'), 'export const main = 1\n')
    await mkdir(join(root, 'secret'), { recursive: true })
    await writeFile(join(root, 'secret', 'token'), 'a-client-credential\n')

    return { base, root }
  }

  it('restores the tree onto the identical absolute path after the root is destroyed', async () => {
    const { base, root } = await buildRoot()
    const out = await scratch()

    const packed = await packWorkspaceArchive({
      workspaceRoot: root,
      tarPath: join(out, 'snapshot.tar'),
      archivePath: join(out, 'snapshot.tar.zst'),
      excludes: [],
    })

    expect(packed.sizeBytes).toBeGreaterThan(0)
    expect(packed.memberPaths.some((member) => member.endsWith('/primary/src/main.ts'))).toBe(true)

    await rm(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)

    await unpackWorkspaceArchive({
      archivePath: packed.archivePath,
      tarPath: join(out, 'restored.tar'),
      workspaceRoot: root,
    })

    expect(base).toBe(archiveAnchorDirectory(root))
    await expect(readFile(join(root, 'primary', 'src', 'main.ts'), 'utf8')).resolves.toBe(
      'export const main = 1\n',
    )
  }, 60_000)

  it('honours an exclusion at pack time, so the excluded bytes are never in the archive', async () => {
    const { root } = await buildRoot()
    const out = await scratch()

    const packed = await packWorkspaceArchive({
      workspaceRoot: root,
      tarPath: join(out, 'snapshot.tar'),
      archivePath: join(out, 'snapshot.tar.zst'),
      excludes: ['./workspace/secret'],
    })

    expect(packed.memberPaths.some((member) => member.includes('/secret/'))).toBe(false)
    expect(packed.memberPaths.some((member) => member.endsWith('/primary/src/main.ts'))).toBe(true)
  }, 60_000)

  it('lists members from the finished archive rather than from the pack arguments', async () => {
    const { root } = await buildRoot()
    const out = await scratch()

    await packWorkspaceArchive({
      workspaceRoot: root,
      tarPath: join(out, 'snapshot.tar'),
      archivePath: join(out, 'snapshot.tar.zst'),
      excludes: [],
    })

    const listed = await listArchiveMembers(join(out, 'snapshot.tar'))

    expect(listed.some((member) => member.endsWith('/secret/token'))).toBe(true)
  }, 60_000)

  it('fails by name when there is nothing at the path to pack', async () => {
    const out = await scratch()

    const failure = await packWorkspaceArchive({
      workspaceRoot: join(out, 'not-here'),
      tarPath: join(out, 'snapshot.tar'),
      archivePath: join(out, 'snapshot.tar.zst'),
      excludes: [],
    }).catch((caught: unknown) => caught)

    expect(failure).toBeInstanceOf(SnapshotArchiveError)
    expect((failure as Error).message).toContain('tar')
  }, 60_000)

  it('fails by name when the archive is not a readable listing', async () => {
    const out = await scratch()
    const junk = join(out, 'junk.tar')

    await writeFile(junk, 'this is not a tar archive')

    await expect(listArchiveMembers(junk)).rejects.toBeInstanceOf(SnapshotArchiveError)
  }, 60_000)
})
