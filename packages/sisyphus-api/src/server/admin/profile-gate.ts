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
  /**
   * The profile's attached credential groups (003/FR-065). Its own element rather than folded into
   * `profile_version`, because attachments hang off the **mutable profile row** and not off a
   * version — see {@link credentialGroupAttachmentCheck} — so a failure here is fixed on a
   * different screen from every other element in this list, and publishing a new version does not
   * touch it.
   */
  'credential_group',
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

/** One attached credential group, as far as this gate is concerned (003/FR-062). */
export interface AttachedCredentialGroup {
  readonly name: string
  readonly enabled: boolean
  readonly archivedAt: Date | null
  readonly position: number
}

/**
 * 003/FR-065's unlaunchable gate — an execution profile with no attached credential group.
 *
 * ## Why this is checked here and not at launch
 *
 * Every run performs its work as an agent credential, and a credential is only reachable through a
 * group its profile is attached to (003/FR-063). A profile with no attachment therefore has no
 * capacity it is allowed to draw on — not "none right now", but none that any future registration
 * could give it without somebody editing this profile. Discovering that at admission would mean the
 * run has already been accepted, has already told an engineer it is starting, and has to be failed
 * or parked in `awaiting_credential` for a wait that can never end; 003/FR-029 would report it as
 * exhaustion, which is exactly the wrong diagnosis for a configuration fault. **Refusing at
 * configuration time is what turns that into a form error in front of the one person who can fix
 * it**, which is the whole of what the requirement asks for.
 *
 * ## Why it names the missing attachment
 *
 * Same argument the module note makes about the other elements: "this profile cannot be enabled" is
 * not actionable in a form holding a bundle, a workspace, a dozen repositories and a group list.
 * The refusal says which of those is empty.
 *
 * ## Why an attachment can also be present and useless
 *
 * A group that has been archived, or disabled, withholds every member from selection (003/FR-006
 * applied group-wide). A profile attached only to such groups satisfies "has an attachment" while
 * having exactly the same launch behaviour as one with none, so it is refused too — and refused
 * with a *different* sentence, because the fix is different: one administrator needs to attach a
 * group, the other needs to re-enable the one already attached.
 *
 * @param attachments - The profile's attachments, from `readProfileCredentialGroups`. Read off the
 *   **mutable `execution_profiles` row** rather than off a version; see `db/schema/credential.ts`
 *   and data-model.md for why that deviates from 002's pattern deliberately.
 */
export const credentialGroupAttachmentCheck = (
  attachments: readonly AttachedCredentialGroup[],
): ProfileEnableCheck => {
  if (attachments.length === 0) {
    return verdict([
      {
        element: 'credential_group',
        detail:
          'this execution profile has no attached credential group, so a run launched from it would have no agent identity it is permitted to work as; attach at least one group before enabling it',
      },
    ])
  }

  const usable = attachments.filter(
    (attachment) => attachment.enabled && attachment.archivedAt === null,
  )

  if (usable.length === 0) {
    return verdict([
      {
        element: 'credential_group',
        detail: `every credential group attached to this execution profile is unavailable (${attachments
          .map((attachment) => attachment.name)
          .join(', ')}), so no credential could ever be selected for a run launched from it`,
      },
    ])
  }

  return verdict([])
}

/**
 * Combine independent verdicts into one, preserving the order the checks were given in.
 *
 * The gate reports **every** failure rather than the first, and that rule has to survive the gate
 * being made of more than one function: an administrator with an unattached credential group *and*
 * an unreachable repository should learn both in one attempt, not discover the second after fixing
 * the first.
 */
export const mergeProfileEnableChecks = (
  ...checks: readonly ProfileEnableCheck[]
): ProfileEnableCheck => verdict(checks.flatMap((check) => check.failures))

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
