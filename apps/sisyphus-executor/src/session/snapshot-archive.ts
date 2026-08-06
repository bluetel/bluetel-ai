/**
 * **The `tar.zst` itself (T097, T098, R2).**
 *
 * Spike S2 exercised this shape end to end and it held: one `tar` of the pinned root, packed from
 * the root's **parent** with the root as a single member, so an extract at the parent puts the tree
 * back at the identical absolute path it was taken from. That is the whole restore mechanism —
 * `--resume` finds the session because the mangled directory name is derived from an absolute path
 * that is the same on both instances (R2, FR-051).
 *
 * Two things differ from the harness, and both narrow the claim rather than extend it:
 *
 * 1. **Compression is `node:zlib`'s zstd rather than the `zstd` binary.** The spike recorded which
 *    one it got and tolerated `none`; production must not, because an uncompressed archive written
 *    under a `.tar.zst` key is a file nothing will be able to read back by its name. Doing it
 *    in-process removes the tool from the instance's dependency list altogether, and it streams,
 *    so a multi-gigabyte workspace is never a buffer.
 * 2. **Members are read back out of the finished archive**, not assumed from what was passed in.
 *    The two state flags FR-050 makes a resume depend on are derived from that listing, so they
 *    describe the archive rather than the intention — see `snapshot.ts`.
 *
 * S2 did **not** exercise a GNU `tar` against a libarchive one. In production both ends are Linux, so the
 * mismatch is a local-development concern; it is named here rather than left to be rediscovered.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'

import { describeExit, runCommand } from '../bootstrap'

/** Raised when `tar` or the compressor failed. Carries what the tool said. */
export class SnapshotArchiveError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'SnapshotArchiveError'
  }
}

/**
 * The member name the pinned root is packed under.
 *
 * Relative and parent-anchored (`./workspace`), which is what makes the extract at the parent
 * directory land on the same absolute path. An absolute member name would make the archive depend
 * on `tar`'s leading-slash stripping, which differs by implementation.
 */
export const archiveMemberName = (workspaceRoot: string): string => `./${basename(workspaceRoot)}`

/** Where the archive is unpacked to: the pinned root's parent, so the root lands back on itself. */
export const archiveAnchorDirectory = (workspaceRoot: string): string => dirname(workspaceRoot)

export interface PackArchiveOptions {
  /** The pinned root (FR-051). */
  readonly workspaceRoot: string
  /** Scratch path for the uncompressed tar. Removed by the caller. */
  readonly tarPath: string
  /** Where the finished `tar.zst` is written. */
  readonly archivePath: string
  /**
   * Paths excluded **at pack time**. Deleting afterwards would mean the secret existed inside the
   * archive for a while, which is precisely what FR-072 forbids.
   */
  readonly excludes: readonly string[]
  readonly signal?: AbortSignal
}

export interface PackedArchive {
  readonly archivePath: string
  readonly sizeBytes: number
  /** Every member, exactly as the finished archive lists them. */
  readonly memberPaths: readonly string[]
}

const excludeArguments = (excludes: readonly string[]): readonly string[] =>
  excludes.flatMap((pattern) => ['--exclude', pattern])

/** List an archive's members. Read from the archive, never inferred from the pack arguments. */
export const listArchiveMembers = async (
  tarPath: string,
  signal?: AbortSignal,
): Promise<readonly string[]> => {
  const result = await runCommand({
    command: 'tar',
    args: ['--list', '--file', tarPath],
    ...(signal === undefined ? {} : { signal }),
  })

  if (result.exitCode !== 0) {
    throw new SnapshotArchiveError(`tar ${describeExit(result)} listing ${tarPath}`)
  }

  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Pack the pinned root, then compress it. */
export const packWorkspaceArchive = async (options: PackArchiveOptions): Promise<PackedArchive> => {
  const { workspaceRoot, tarPath, archivePath, excludes } = options
  const signal = options.signal

  const result = await runCommand({
    command: 'tar',
    args: [
      '--create',
      '--file',
      tarPath,
      ...excludeArguments(excludes),
      '--directory',
      archiveAnchorDirectory(workspaceRoot),
      archiveMemberName(workspaceRoot),
    ],
    ...(signal === undefined ? {} : { signal }),
  })

  if (result.exitCode !== 0) {
    throw new SnapshotArchiveError(
      `tar ${describeExit(result)} packing ${workspaceRoot}. ${result.output.trim()}`.trim(),
    )
  }

  const memberPaths = await listArchiveMembers(tarPath, signal)

  await pipeline(createReadStream(tarPath), createZstdCompress(), createWriteStream(archivePath))

  const { size } = await stat(archivePath)

  return { archivePath, sizeBytes: size, memberPaths }
}

export interface UnpackArchiveOptions {
  /** The downloaded `tar.zst`. */
  readonly archivePath: string
  /** Scratch path for the decompressed tar. */
  readonly tarPath: string
  /** The pinned root the archive is restored onto — the same absolute path it was taken from. */
  readonly workspaceRoot: string
  readonly signal?: AbortSignal
}

/** Decompress and extract, back onto the pinned root. */
export const unpackWorkspaceArchive = async (
  options: UnpackArchiveOptions,
): Promise<readonly string[]> => {
  const signal = options.signal

  await pipeline(
    createReadStream(options.archivePath),
    createZstdDecompress(),
    createWriteStream(options.tarPath),
  )

  const memberPaths = await listArchiveMembers(options.tarPath, signal)

  const result = await runCommand({
    command: 'tar',
    args: [
      '--extract',
      '--file',
      options.tarPath,
      '--directory',
      archiveAnchorDirectory(options.workspaceRoot),
    ],
    ...(signal === undefined ? {} : { signal }),
  })

  if (result.exitCode !== 0) {
    throw new SnapshotArchiveError(
      `tar ${describeExit(result)} extracting onto ${options.workspaceRoot}. ` +
        result.output.trim(),
    )
  }

  return memberPaths
}
