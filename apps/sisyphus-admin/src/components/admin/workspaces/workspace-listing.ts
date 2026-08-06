import { formatTimestamp } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping one `admin.workspaces.list` row into the readouts a card renders (T082, FR-125, FR-127).
 *
 * ## The version is the point, so it is the first thing shaped
 *
 * A workspace is not a row that gets edited. Editing publishes a **new version** with its own entry
 * rows, and a workflow that pinned version 3 keeps resolving version 3's repositories for the rest
 * of its life. A screen that showed a name, a description and a list of repositories — with no
 * version anywhere — would teach an admin that they are editing the thing runs use, which is the
 * one belief this system is built to make false.
 *
 * So every readout here names the version: which one a launch would pin now, how many exist, and
 * when the current one was published. `versionCount` in particular is what makes an edit visible
 * afterwards — the number goes up, and nothing else about the workspace appears to have moved.
 *
 * The type comes from `RouterOutputs`, never from a hand-written DTO: a mirrored interface drifts
 * silently, because nothing fails when the procedure adds a column and the copy does not.
 */

/** One workspace as `admin.workspaces.list` returns it. */
export type WorkspaceListItem = RouterOutputs['admin']['workspaces']['list']['items'][number]

/** One repository in the pinned version. */
export type WorkspaceEntryItem = NonNullable<WorkspaceListItem['currentVersion']>['entries'][number]

/** What an absent value reads as. An em dash, matching the fleet list rather than a second dash. */
export const ABSENT = '—'

/** A labelled machine readout, as `DataReadout` takes it. */
export interface WorkspaceReadout {
  readonly label: string
  readonly value: string
}

/** What one workspace card puts on screen. Every value is a string, because every value is a readout. */
export interface WorkspaceReadouts {
  readonly id: string
  readonly name: string
  readonly description: string
  /** `enabled`, `disabled` or `archived` — one word, and the chip's readout. */
  readonly state: string
  /** `v3 of 7` — the version a launch pins, and how many have ever been published. */
  readonly version: string
  readonly publishedAt: string
  readonly entryCount: string
  /** The version row's id, which is what a run records and what a support question quotes. */
  readonly currentVersionId: string
  readonly entries: readonly WorkspaceEntryReadouts[]
  /** Whether an edit is possible at all — an archived workspace is refused by the router. */
  readonly editable: boolean
  readonly enabled: boolean
}

/** One repository row inside a version. */
export interface WorkspaceEntryReadouts {
  readonly id: string
  readonly repositoryUrl: string
  readonly baseBranch: string
  readonly subdirectory: string
  /** `primary` or `secondary` — FR-110's exactly-one rule, said out loud on every row. */
  readonly role: string
}

/** How a workspace's availability reads. Archived wins, because it is the state that forbids edits. */
export const workspaceStateReadout = (item: WorkspaceListItem): string => {
  if (item.archivedAt !== null) return 'archived'
  return item.enabled ? 'enabled' : 'disabled'
}

/**
 * How the version reads.
 *
 * `v3 of 7` rather than `v3`, because the second number is the only thing on the card that says an
 * edit happened. A workspace whose current version is 3 of 7 has been edited four times since a run
 * that pinned version 3 started, and that run is still using version 3.
 */
export const workspaceVersionReadout = (item: WorkspaceListItem): string =>
  item.currentVersion === undefined
    ? 'none published'
    : `v${String(item.currentVersion.version)} of ${String(item.versionCount)}`

/** Derive the readouts for one workspace card. */
export const toWorkspaceReadouts = (item: WorkspaceListItem): WorkspaceReadouts => ({
  id: item.id,
  name: item.name,
  description: item.description ?? ABSENT,
  state: workspaceStateReadout(item),
  version: workspaceVersionReadout(item),
  publishedAt:
    item.currentVersion === undefined ? ABSENT : formatTimestamp(item.currentVersion.createdAt),
  entryCount: String(item.currentVersion?.entries.length ?? 0),
  currentVersionId: item.currentVersion?.id ?? ABSENT,
  entries: (item.currentVersion?.entries ?? []).map((entry) => ({
    id: entry.id,
    repositoryUrl: entry.repositoryUrl,
    baseBranch: entry.baseBranch,
    subdirectory: entry.subdirectory,
    role: entry.isPrimary ? 'primary' : 'secondary',
  })),
  editable: item.archivedAt === null,
  enabled: item.enabled,
})
