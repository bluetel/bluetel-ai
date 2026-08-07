import { formatTimestamp } from '@sisyphus-admin/components/admin'
import type { RouterOutputs } from '@sisyphus-admin/trpc'

/**
 * Shaping one `admin.profiles.list` row into the readouts a card renders (T082, FR-121, FR-125,
 * FR-126, FR-127).
 *
 * ## The version is the point, so it is the first thing shaped
 *
 * An execution profile is not a row that gets edited. Editing publishes a new immutable version,
 * and a workflow records the `execution_profile_version_id` it launched with — which is what
 * reconstructs its exact configuration for the retention period. A screen that showed a model, an
 * instance size and two caps with no version anywhere would teach an admin that they are editing
 * the configuration runs use, which is the belief FR-125 exists to make false.
 *
 * So the card leads with `v3 of 7`, and every value below it is stated as a property of that
 * version rather than of the profile.
 *
 * The type comes from `RouterOutputs`, never from a hand-written DTO.
 */

/** One profile as `admin.profiles.list` returns it. */
export type ProfileListItem = RouterOutputs['admin']['profiles']['list']['items'][number]

/** The immutable version a launch would pin. */
export type ProfileVersionItem = NonNullable<ProfileListItem['currentVersion']>

/** What an absent value reads as. An em dash, matching the fleet list. */
export const ABSENT = '—'

/** What one profile card puts on screen. Every value is a string, because every value is a readout. */
export interface ProfileReadouts {
  readonly id: string
  readonly name: string
  readonly description: string
  /** `enabled`, `disabled` or `archived` — one word, and the chip's readout. */
  readonly state: string
  /** `v3 of 7` — the version a launch pins, and how many have ever been published. */
  readonly version: string
  /** The version row's id, which is what a run records (FR-126). */
  readonly currentVersionId: string
  readonly publishedAt: string
  readonly workspaceVersionId: string
  readonly setupBundleVersionId: string
  readonly model: string
  readonly instanceType: string
  readonly purchaseMode: string
  readonly turnCap: string
  readonly spendCap: string
  readonly defaultWorkflowType: string
  readonly promptPreamble: string
  /** The fields this version forbids overriding, as a readout (FR-123). */
  readonly lockedFields: string
  readonly enabled: boolean
  /** Whether an edit is possible at all — an archived profile is refused by the router. */
  readonly editable: boolean
  /** Whether it has a version to clone or to validate. */
  readonly published: boolean
}

/** How a profile's availability reads. Archived wins, because it is the state that forbids edits. */
export const profileStateReadout = (item: ProfileListItem): string => {
  if (item.archivedAt !== null) return 'archived'
  return item.enabled ? 'enabled' : 'disabled'
}

/**
 * How the version reads.
 *
 * `v3 of 7` rather than `v3`, because the second number is the only thing on the card that says an
 * edit happened at all. A run launched last week may be pinned to any of the seven.
 */
export const profileVersionReadout = (item: ProfileListItem): string =>
  item.currentVersion === undefined
    ? 'none published'
    : `v${String(item.currentVersion.version)} of ${String(item.versionCount)}`

/** A cap the profile does not set reads as "no cap", which is a real answer rather than a gap. */
const capReadout = (value: number | string | null): string =>
  value === null ? 'no cap' : String(value)

/** Derive the readouts for one profile card. */
export const toProfileReadouts = (item: ProfileListItem): ProfileReadouts => {
  const version = item.currentVersion

  return {
    id: item.id,
    name: item.name,
    description: item.description ?? ABSENT,
    state: profileStateReadout(item),
    version: profileVersionReadout(item),
    currentVersionId: version?.id ?? ABSENT,
    publishedAt: version === undefined ? ABSENT : formatTimestamp(version.createdAt),
    workspaceVersionId: version?.workspaceVersionId ?? ABSENT,
    setupBundleVersionId: version?.setupBundleVersionId ?? ABSENT,
    model: version?.model ?? ABSENT,
    instanceType: version?.instanceType ?? ABSENT,
    purchaseMode: version?.purchaseMode ?? ABSENT,
    turnCap: version === undefined ? ABSENT : capReadout(version.turnCap),
    spendCap: version === undefined ? ABSENT : capReadout(version.spendCap),
    defaultWorkflowType: version?.defaultWorkflowType ?? ABSENT,
    promptPreamble: version?.promptPreamble ?? ABSENT,
    lockedFields:
      version === undefined || version.lockedFields.length === 0
        ? 'none'
        : version.lockedFields.join(', '),
    enabled: item.enabled,
    editable: item.archivedAt === null,
    published: version !== undefined,
  }
}
