import { TRPCError } from '@trpc/server'

import type { ProfileEnableSubject } from './profile-store'

/**
 * FR-124's enable gate — the check that stops a profile/bundle mismatch reaching a run.
 *
 * ## What it checks
 *
 * An execution profile may not be enabled until validation confirms all of:
 *
 * 1. the profile has a published version at all, and that version's pinned rows can still be read;
 * 2. the setup bundle version it pins belongs to a bundle that is **enabled** and not archived;
 * 3. the workspace it pins is not archived; and
 * 4. the workspace version it pins contains at least one entry. A workspace version with no
 *    entries produces a run with nothing to check out, and the executor discovers that at phase 6
 *    having already paid for an instance.
 *
 * Together these are the difference between "this preset looks fine" and "this preset can start a
 * run". Without them, a bundle taken out of circulation can stay attached to a profile and nothing
 * notices until an agent is running against a tree that does not match its setup.
 *
 * ## What it deliberately does not check
 *
 * FR-124 once also required that every workspace entry's repository and base branch be reachable
 * with the credentials available. That half has been withdrawn (`specs/004-remove-reachability-gate`)
 * because it was never satisfiable from here: the repository-host credential is installed by a
 * client-authored setup bundle onto an ephemeral executor instance, in a format the bundle contract
 * deliberately leaves unspecified, and it never leaves that instance. The panel structurally cannot
 * hold it.
 *
 * A wrong repository or branch therefore surfaces at bootstrap phase 6 (`entry_checkout`), which
 * already fails the run naming the entry, the repository, the branch and git's own error, and
 * leaves no partial workspace behind (FR-112). That is the accepted cost, and it is why this module
 * must never grow a check it cannot actually perform: the previous attempt shipped as a
 * refuse-by-default stub that no deployment could wire, so no profile could be enabled in any
 * deployment.
 *
 * ## Why it refuses by name
 *
 * "This profile cannot be enabled" tells an admin nothing: they hold a form with a bundle, a
 * workspace and up to a dozen repositories on it, and the platform has just declined to say which
 * one is wrong. "The setup bundle node-20 (version 4) is disabled; enable it before enabling this
 * profile" tells them what to fix and where. So the gate collects **every** failure rather than
 * stopping at the first, and each one names its element.
 *
 * ## Why it is a pure function
 *
 * Everything it judges arrives as {@link ProfileEnableSubject}, read by `profile-store.ts`. The
 * gate makes no call of its own — no network, no database — so the rule can be tested against a
 * disabled bundle, an archived workspace, an empty workspace version and every combination, with
 * nothing but a value. The signature is synchronous to keep that true: a `Promise` here would leave
 * room for an outbound call to be slipped back in without the type changing.
 */

/** Which element of the configuration failed. Closed, so the panel can group failures by cause. */
export const PROFILE_ENABLE_ELEMENTS = [
  'profile_version',
  'setup_bundle',
  'workspace_version',
] as const

export type ProfileEnableElement = (typeof PROFILE_ENABLE_ELEMENTS)[number]

/** One reason the profile cannot be enabled, naming the element it is about. */
export interface ProfileEnableFailure {
  readonly element: ProfileEnableElement
  /** A sentence naming the failing element and what is wrong with it. */
  readonly detail: string
}

/** The gate's verdict. `passed` is exactly `failures.length === 0`; both are given so neither is inferred. */
export interface ProfileEnableCheck {
  readonly passed: boolean
  readonly failures: readonly ProfileEnableFailure[]
}

/** A verdict from a list of failures, so `passed` can never disagree with `failures`. */
const verdict = (failures: readonly ProfileEnableFailure[]): ProfileEnableCheck => ({
  passed: failures.length === 0,
  failures,
})

/** The refusal for a profile with no published version at all. */
export const noPublishedVersionCheck = (): ProfileEnableCheck =>
  verdict([
    {
      element: 'profile_version',
      detail:
        'this execution profile has no published version, so there is no configuration to validate',
    },
  ])

/** The refusal for a version whose pinned bundle or workspace version could not be read. */
export const unreadableSubjectCheck = (): ProfileEnableCheck =>
  verdict([
    {
      element: 'profile_version',
      detail:
        'the setup bundle version or workspace version this profile pins could not be read, so it cannot be validated',
    },
  ])

/**
 * Run the gate (FR-124).
 *
 * @param subject - The pinned bundle, workspace and entries, from `readProfileEnableSubject`.
 */
export const checkProfileCanBeEnabled = (subject: ProfileEnableSubject): ProfileEnableCheck => {
  const failures: ProfileEnableFailure[] = []

  if (subject.setupBundleArchived) {
    failures.push({
      element: 'setup_bundle',
      detail: `the setup bundle ${subject.setupBundleName} (version ${String(subject.setupBundleVersion)}) has been archived`,
    })
  } else if (!subject.setupBundleEnabled) {
    // The first half of FR-124, and the one that catches a bundle taken out of circulation after
    // the profile was built. Reported instead of the archive check rather than alongside it: an
    // archived bundle is always disabled too, and saying both would be one problem stated twice.
    failures.push({
      element: 'setup_bundle',
      detail: `the setup bundle ${subject.setupBundleName} (version ${String(subject.setupBundleVersion)}) is disabled; enable it before enabling this profile`,
    })
  }

  if (subject.workspaceArchived) {
    failures.push({
      element: 'workspace_version',
      detail: `the workspace ${subject.workspaceName} has been archived`,
    })
  }

  if (subject.entries.length === 0) {
    failures.push({
      element: 'workspace_version',
      detail: `version ${String(subject.workspaceVersion)} of the workspace ${subject.workspaceName} contains no repositories, so a run launched from this profile would have nothing to check out`,
    })
  }

  // The entries themselves are not inspected beyond being counted. Whether each repository and
  // branch actually exists is settled at checkout, by the credential that will do the cloning —
  // see the module header.
  return verdict(failures)
}

/**
 * Turn a failed check into the refusal an admin sees.
 *
 * `CONFLICT` rather than `FORBIDDEN` or `BAD_REQUEST`: the caller is an admin entitled to enable
 * profiles and the request is well-formed — what is wrong is the state of what they are pointing
 * at. Every failure is listed, one per line, because an admin fixing three broken repositories
 * should not have to discover them one enable attempt at a time.
 *
 */
export const profileCannotBeEnabledError = (check: ProfileEnableCheck): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: [
      'This execution profile cannot be enabled yet:',
      ...check.failures.map((failure) => `- ${failure.detail}`),
    ].join('\n'),
  })
