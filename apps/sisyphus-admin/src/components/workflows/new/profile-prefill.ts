import type { RouterOutputs } from '@sisyphus-admin/trpc'

import type { LaunchFormValues } from './launch-form-values'
import { EMPTY_LAUNCH_FORM } from './launch-form-values'
import type { LaunchOption } from './launch-select'

/**
 * Turning a chosen execution profile into a filled-in launch form (T080, FR-016, FR-122).
 *
 * ## Prefill is the requirement, not a convenience
 *
 * FR-122 is unusually literal: selecting a profile prefills **every** value it carries, and the run
 * must be startable "without the user supplying anything but the prompt". So this module maps a
 * profile version onto {@link LaunchFormValues} field for field, and the mapping is total — a field
 * left blank here is a value the run would use and the operator never saw, which is the same defect
 * as showing them the wrong one.
 *
 * ## Why the prompt survives a profile change
 *
 * Choosing a profile is often the *second* thing an operator does: they arrive knowing what they
 * want done, type it, and then pick the preset it should run under. A prefill that emptied the
 * prompt would delete the one thing they actually authored, so {@link prefillFromProfile} takes the
 * current values and replaces only what the profile carries.
 *
 * The prompt **preamble** is deliberately not merged into the prompt here. FR-157 has the platform
 * assemble it at launch; a form that pasted it into the textarea would let an operator edit or
 * delete a value the profile is supposed to guarantee, and would then send it as though it were
 * theirs. It is shown as a readout instead.
 */

/** One profile as `admin.profiles.list` returns it. Inferred, never mirrored. */
export type LaunchProfile = RouterOutputs['admin']['profiles']['list']['items'][number]

/** The immutable version a launch would pin. `undefined` for a profile with nothing published. */
export type LaunchProfileVersion = NonNullable<LaunchProfile['currentVersion']>

/**
 * The profiles a launch may actually be started from.
 *
 * Enabled, unarchived and holding a published version — the same three conditions
 * `loadLaunchableProfileVersion` applies on the server. Offering one that fails any of them would
 * be a picker whose choice is refused a moment later, which DESIGN.md calls a form that lies to the
 * person filling it in.
 */
export const launchableProfiles = (profiles: readonly LaunchProfile[]): readonly LaunchProfile[] =>
  profiles.filter(
    (profile) =>
      profile.enabled && profile.archivedAt === null && profile.currentVersion !== undefined,
  )

/**
 * The picker's options, labelled with the version a launch would pin.
 *
 * The version number is in the label rather than in a tooltip because it is the answer to the
 * question this whole screen exists to make answerable: a run records the version it launched from,
 * and an operator comparing two runs of "the same profile" needs to see that they were not.
 */
export const profileLaunchOptions = (profiles: readonly LaunchProfile[]): readonly LaunchOption[] =>
  launchableProfiles(profiles).map((profile) => ({
    value: profile.id,
    label: `${profile.name} — v${String(profile.currentVersion?.version ?? 0)}`,
  }))

/** The chosen profile, or `undefined` when nothing is chosen or the choice is no longer launchable. */
export const findLaunchProfile = (
  profiles: readonly LaunchProfile[],
  executionProfileId: string,
): LaunchProfile | undefined =>
  launchableProfiles(profiles).find((profile) => profile.id === executionProfileId)

/** A cap the form holds as text: blank means "no cap", which is a real answer for a delegated run. */
const capText = (value: number | string | null): string => (value === null ? '' : String(value))

/**
 * Fill the form from a profile version (FR-122).
 *
 * @param version - The immutable version the run would pin.
 * @param current - What the controls hold now. Only the prompt and the ticket reference survive:
 *   both are the operator's own words about this particular run, and neither is a profile value.
 * @returns Every launch value the profile carries, with the operator's own text left alone.
 */
export const prefillFromProfile = (
  version: LaunchProfileVersion,
  current: LaunchFormValues = EMPTY_LAUNCH_FORM,
): LaunchFormValues => ({
  ...EMPTY_LAUNCH_FORM,
  workspaceSource: 'workspace',
  workspaceVersionId: version.workspaceVersionId,
  workflowType: version.defaultWorkflowType,
  model: version.model,
  instanceType: version.instanceType,
  purchaseMode: version.purchaseMode,
  turnCap: capText(version.turnCap),
  spendCap: capText(version.spendCap),
  setupBundleVersionId: version.setupBundleVersionId,
  prompt: current.prompt,
  ticketReference: current.ticketReference,
})

/** A labelled readout of the profile version, for the card that says what this run will use. */
export interface ProfileVersionReadout {
  readonly label: string
  readonly value: string
}

/** What an absent value reads as, matching the fleet list rather than inventing a second dash. */
export const ABSENT_PROFILE_VALUE = '—'

/**
 * The values a launch takes from the profile that no control on this form edits.
 *
 * The workspace version and the bundle version are pinned by the profile and are not overridable at
 * all — they are not in `OVERRIDABLE_FIELDS` — so they appear here as readouts. Showing them is
 * FR-122's other half: a run startable with one field still has to say what the other twelve are.
 */
export const profileVersionReadouts = (
  version: LaunchProfileVersion,
): readonly ProfileVersionReadout[] => [
  { label: 'profile version', value: `v${String(version.version)}` },
  { label: 'workspace version', value: version.workspaceVersionId },
  { label: 'setup bundle version', value: version.setupBundleVersionId },
  {
    label: 'prompt preamble',
    value: version.promptPreamble ?? ABSENT_PROFILE_VALUE,
  },
]
