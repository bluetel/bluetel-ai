import { TRPCError } from '@trpc/server'

import type { ProfileEnableSubject } from './profile-store'
import type { ReachabilityTarget, RepositoryReachabilityProbe } from './reachability'
import { probeTargets } from './reachability'
import { describeWorkspaceEntry } from './workspace-entries'

/**
 * FR-124's enable gate — the check that stops a profile/bundle mismatch reaching a run.
 *
 * ## What it checks
 *
 * An execution profile may not be enabled until validation confirms **both** halves of FR-124:
 *
 * 1. the setup bundle version it pins belongs to a bundle that is **enabled** and not archived; and
 * 2. **every** entry of the workspace version it pins is reachable — repository and base branch
 *    together — with the credentials available.
 *
 * Plus the structural minimum the two halves assume: a profile must actually have a published
 * version, that version's pinned rows must still be there, and the workspace version must contain
 * at least one entry. A workspace version with no entries produces a run with nothing to check out,
 * and the executor discovers that at phase 6 having already paid for an instance.
 *
 * Together these are the difference between "this preset looks fine" and "this preset can start a
 * run". Without them, a bundle written for one repository set can be attached to another and
 * nothing notices until an agent is running against a tree that does not match its setup.
 *
 * ## Why it refuses by name
 *
 * "This profile cannot be enabled" tells an admin nothing: they hold a form with a bundle, a
 * workspace and up to a dozen repositories on it, and the platform has just declined to say which
 * one is wrong. "Workspace entry 2 (github.com/acme/api on main) is unreachable: the credential
 * cannot read this repository" tells them what to fix and where. So the gate collects **every**
 * failure rather than stopping at the first, and each one names its element.
 *
 * ## Why it is a pure function
 *
 * Everything it judges arrives as {@link ProfileEnableSubject} — read by `profile-store.ts` — and
 * the one outbound call goes through {@link RepositoryReachabilityProbe}. So the rule can be tested
 * against a reachable host, an unreachable one, a missing branch, a disabled bundle and every
 * combination, without a network and without a database.
 */

/** Which element of the configuration failed. Closed, so the panel can group failures by cause. */
export const PROFILE_ENABLE_ELEMENTS = [
  'profile_version',
  'setup_bundle',
  'workspace_version',
  'workspace_entry',
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
 * @param probe - The outbound seam. Every entry is probed, including after one has failed.
 */
export const checkProfileCanBeEnabled = async (
  subject: ProfileEnableSubject,
  probe: RepositoryReachabilityProbe,
): Promise<ProfileEnableCheck> => {
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

    // Nothing to probe, and reporting "0 entries unreachable" alongside would read as a second
    // problem.
    return verdict(failures)
  }

  const targets: readonly ReachabilityTarget[] = subject.entries.map((entry) => ({
    repositoryUrl: entry.repositoryUrl,
    baseBranch: entry.baseBranch,
  }))

  const reports = await probeTargets(probe, targets)

  reports.forEach((report, index) => {
    if (report.outcome.reachable) {
      return
    }

    failures.push({
      element: 'workspace_entry',
      detail: `${describeWorkspaceEntry(index + 1, report.target)} is unreachable: ${report.outcome.reason}`,
    })
  })

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
