import { TRPCError } from '@trpc/server'

import type { WorkspaceEntryInput } from '../../schemas'

/**
 * Validating a workspace's entry list (FR-110, FR-111).
 *
 * Pure: no database handle, no context, no clock. The rules here are the ones that decide what a
 * run will check out, and a function that needed a transaction to answer would be tested once and
 * by accident.
 *
 * `workspaceEntryListInput` in `src/schemas/workspace.ts` already refuses a list with the wrong
 * number of primaries or a repeated subdirectory. This module exists because two of FR-111's
 * requirements cannot be expressed there:
 *
 * 1. **A subdirectory must resolve inside the pinned root.** `../../etc` and `/etc` are both
 *    non-empty strings, so a `min(1)` accepts them; what refuses them is normalising the path and
 *    seeing where it lands. The workspace root is the single pinned, snapshot-able tree FR-051
 *    depends on, and an entry that escapes it makes the snapshot a description of somewhere else.
 * 2. **Uniqueness must be checked after normalisation.** `services/api` and `services/api/` are
 *    different strings and the same directory, so a check on the raw text passes a list that then
 *    loses one entry's contents to the other at checkout.
 *
 * Positions are checked here too, because `workspace_entries_position_key` is a unique index and a
 * duplicate would otherwise surface as a constraint violation rather than as a message naming the
 * offending row.
 */

/** Why a subdirectory was refused. Closed, so a new reason cannot be added without a message. */
export const SUBDIRECTORY_REJECTIONS = [
  'empty',
  'absolute',
  'escapes_root',
  'backslash',
  'unsafe_character',
] as const

export type SubdirectoryRejection = (typeof SUBDIRECTORY_REJECTIONS)[number]

/** Either the path as it will be stored, or the reason it cannot be. */
export type SubdirectoryResult =
  | { readonly outcome: 'accepted'; readonly subdirectory: string }
  | { readonly outcome: 'rejected'; readonly reason: SubdirectoryRejection }

/** The refusal in words, for a message an admin can act on. */
export const describeSubdirectoryRejection = (reason: SubdirectoryRejection): string => {
  switch (reason) {
    case 'empty':
      return 'names no directory once separators are removed'
    case 'absolute':
      return 'is an absolute path, so it would be checked out outside the workspace root'
    case 'escapes_root':
      return 'climbs above the workspace root'
    case 'backslash':
      return 'contains a backslash; separate path segments with a forward slash'
    case 'unsafe_character':
      return 'contains a character that is not allowed in a checkout path'
  }
}

/**
 * Anything outside printable ASCII — control characters, and the exotic whitespace that looks like
 * a space and is not.
 *
 * Written as "not in the printable range" rather than as a class over the control range, which is
 * what `no-control-regex` exists to catch and is easy to get quietly wrong in an escape sequence.
 * Restricting a checkout path to ASCII is a deliberate narrowing: the path is interpolated into
 * shell commands on the instance, and a repository whose directory needs more than ASCII can be
 * given a subdirectory that does not.
 */
const outsidePrintableAscii = /[^ -~]/

/** The tilde too, which a shell would expand to somebody's home directory. */
const containsUnsafeCharacter = (value: string): boolean =>
  outsidePrintableAscii.test(value) || value.includes('~')

/**
 * Reduce a submitted subdirectory to the form that is stored, or say why it cannot be.
 *
 * The returned value is what goes in the row, so `services/api/` and `./services/api` become the
 * same string and the unique index does the rest. Refusing to normalise — storing what was typed —
 * would leave the index enforcing a rule about text while the executor obeys a rule about paths.
 */
export const normaliseSubdirectory = (value: string): SubdirectoryResult => {
  const trimmed = value.trim()

  if (containsUnsafeCharacter(trimmed)) {
    return { outcome: 'rejected', reason: 'unsafe_character' }
  }

  if (trimmed.includes('\\')) {
    return { outcome: 'rejected', reason: 'backslash' }
  }

  // A leading slash, or a Windows drive letter, is an absolute path however the rest reads.
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    return { outcome: 'rejected', reason: 'absolute' }
  }

  const segments: string[] = []
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }

    if (segment === '..') {
      // Popping the last segment would let `a/../../b` land outside the root by arithmetic that
      // looks balanced. Anything that pops past the start is refused outright rather than clamped:
      // clamping silently changes where the repository is checked out.
      if (segments.length === 0) {
        return { outcome: 'rejected', reason: 'escapes_root' }
      }
      segments.pop()
      continue
    }

    segments.push(segment)
  }

  if (segments.length === 0) {
    return { outcome: 'rejected', reason: 'empty' }
  }

  return { outcome: 'accepted', subdirectory: segments.join('/') }
}

/** One entry as it will be written to `workspace_entries`. */
export interface NormalisedWorkspaceEntry {
  readonly repositoryUrl: string
  readonly baseBranch: string
  readonly subdirectory: string
  readonly isPrimary: boolean
  readonly position: number
}

/** Anything carrying the two fields an entry is identified by in a message. */
export interface DescribableEntry {
  readonly repositoryUrl: string
  readonly baseBranch: string
}

/**
 * Name one entry the way every refusal in this feature names it.
 *
 * "Workspace entry 2 (github.com/acme/api on main)" tells an admin which row of the form to fix.
 * "The workspace is invalid" tells them to go and read the database. The ordinal is the entry's
 * place in the list as submitted, because that is the only identifier the form has — a version's
 * entries have no ids until the version exists.
 *
 * @param ordinal - 1-based place in the entry list.
 */
export const describeWorkspaceEntry = (ordinal: number, entry: DescribableEntry): string =>
  `workspace entry ${ordinal} (${entry.repositoryUrl} on ${entry.baseBranch})`

/**
 * Refusal for an entry list that cannot become a version.
 *
 * `BAD_REQUEST` rather than `CONFLICT`: the caller is an admin entitled to make the request, and
 * what is wrong is the submission. Every message names the entry, because a form that says only
 * "invalid" leaves an admin comparing rows by eye.
 */
export const workspaceEntryError = (message: string): TRPCError =>
  new TRPCError({ code: 'BAD_REQUEST', message })

/**
 * Normalise and check a whole entry list (FR-110, FR-111).
 *
 * @param entries - The list as submitted. An edit submits the **whole** list rather than a patch,
 *   so this sees everything the new version will contain.
 * @returns The entries in position order, with subdirectories in stored form.
 * @throws {@link workspaceEntryError} naming the first offending entry.
 */
export const normaliseWorkspaceEntries = (
  entries: readonly WorkspaceEntryInput[],
): readonly NormalisedWorkspaceEntry[] => {
  if (entries.length === 0) {
    throw workspaceEntryError('A workspace must contain at least one repository.')
  }

  const ordered = [...entries].sort((left, right) => left.position - right.position)
  const normalised: NormalisedWorkspaceEntry[] = []
  const seenSubdirectories = new Map<string, number>()
  const seenPositions = new Map<number, number>()

  ordered.forEach((entry, index) => {
    const ordinal = index + 1
    const result = normaliseSubdirectory(entry.subdirectory)

    if (result.outcome === 'rejected') {
      throw workspaceEntryError(
        `The subdirectory of ${describeWorkspaceEntry(ordinal, entry)} ` +
          `${describeSubdirectoryRejection(result.reason)}.`,
      )
    }

    const clashingSubdirectory = seenSubdirectories.get(result.subdirectory)
    if (clashingSubdirectory !== undefined) {
      throw workspaceEntryError(
        `${describeWorkspaceEntry(ordinal, entry)} checks out into ${result.subdirectory}, ` +
          `which workspace entry ${clashingSubdirectory} already uses.`,
      )
    }
    seenSubdirectories.set(result.subdirectory, ordinal)

    const clashingPosition = seenPositions.get(entry.position)
    if (clashingPosition !== undefined) {
      throw workspaceEntryError(
        `${describeWorkspaceEntry(ordinal, entry)} and workspace entry ${clashingPosition} ` +
          `both claim position ${entry.position}.`,
      )
    }
    seenPositions.set(entry.position, ordinal)

    normalised.push({
      repositoryUrl: entry.repositoryUrl,
      baseBranch: entry.baseBranch,
      subdirectory: result.subdirectory,
      isPrimary: entry.isPrimary,
      position: entry.position,
    })
  })

  const primaries = normalised.filter((entry) => entry.isPrimary)
  if (primaries.length !== 1) {
    // Also a partial unique index on the table. Checked here so the message says which rule was
    // broken and how, rather than surfacing `workspace_entries_primary_key` to an admin.
    throw workspaceEntryError(
      `Exactly one entry must be primary; this workspace has ${primaries.length}. ` +
        'The primary entry supplies the skills that govern the run.',
    )
  }

  return normalised
}
