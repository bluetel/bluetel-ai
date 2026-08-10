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
 * a disabled setup bundle should learn both in one attempt, not discover the second after fixing
 * the first.
 */
export const mergeProfileEnableChecks = (
  ...checks: readonly ProfileEnableCheck[]
): ProfileEnableCheck => verdict(checks.flatMap((check) => check.failures))

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
