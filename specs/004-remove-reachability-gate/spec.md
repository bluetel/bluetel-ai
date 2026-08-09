# Feature Specification: Remove the repository-reachability half of the profile enable gate

**Feature Branch**: `feature/sisyphus`

**Created**: 2026-08-09

**Status**: Draft

**Input**: User description: "Remove the FR-124 repository reachability half of the execution-profile enable gate. It was never implementable — the repository-host credential lives only on an ephemeral executor instance, installed by a client-authored setup bundle in a deliberately unspecified format, so the admin panel structurally cannot hold it. The shipped code refuses every enable. This is a small internal tool; accept unverified repository input at enable time."

## Why This Change

An execution profile is the saved preset a run launches from. A profile must be **enabled** before anyone can
launch from it. Today **no profile in any deployment can ever be enabled**: the enable gate requires proof that
every repository in the profile's workspace is reachable, the platform has no way to obtain that proof, and the
gate therefore refuses every attempt with `E_PROFILE_ENABLE_WORKSPACE_ENTRY — this deployment has no repository
reachability checker configured`.

The refusal is honest rather than buggy — the platform genuinely cannot confirm what it was told to confirm —
but the requirement behind it cannot be satisfied by any amount of implementation. The credential that could
answer "can this repository be read?" is installed onto a short-lived worker machine by a customer-authored
setup script, in a format the platform deliberately does not specify, and it never leaves that machine. There
is no version of the admin panel that holds it.

So the requirement is withdrawn rather than implemented. The platform stops claiming to verify repository
reachability at configuration time, and an unreachable repository is discovered where it always actually was
discovered — when a run tries to check it out, which already fails with a message naming the entry, the
repository, the branch, and the underlying error.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - An administrator enables an execution profile (Priority: P1)

An administrator has created an execution profile pointing at an enabled setup bundle and a workspace holding
one or more repositories. They turn the profile on, and it turns on. Users can then launch runs from it.

**Why this priority**: This is the entire feature. Profile-based launching is the primary path for every
non-administrator user, and it is currently unreachable — not degraded, but wholly unavailable. Nothing else in
this change matters if this does not work.

**Independent Test**: Create a profile against an enabled bundle and a workspace with at least one repository,
enable it, and confirm it reports as enabled and becomes selectable on the launch form.

**Acceptance Scenarios**:

1. **Given** a profile with a published version pinning an enabled setup bundle and a workspace version holding
   at least one repository, **When** an administrator enables it, **Then** the profile becomes enabled and the
   act is recorded in the configuration audit trail.
2. **Given** a profile whose workspace names a repository that does not exist, **When** an administrator enables
   it, **Then** the profile becomes enabled — the platform does not attempt to verify the repository.
3. **Given** a profile that is already enabled, **When** an administrator enables it again, **Then** the request
   succeeds without recording a second enable in the audit trail.

---

### User Story 2 - An administrator is still stopped by the problems the platform can actually see (Priority: P2)

An administrator tries to enable a profile whose setup bundle has since been disabled, or whose workspace holds
no repositories at all. The platform refuses and names exactly which element is wrong, as it does today.

**Why this priority**: Removing the unimplementable check must not remove the implementable ones alongside it.
These checks cost nothing, need no network and no credential, and each catches a real misconfiguration that
would otherwise waste a paid worker machine. Losing them would trade one broken behaviour for another.

**Independent Test**: For each retained check, construct a profile that violates it, attempt to enable, and
confirm the refusal names the failing element and states a next action.

**Acceptance Scenarios**:

1. **Given** a profile pinning a setup bundle that is disabled, **When** an administrator enables it, **Then**
   the request is refused, naming the bundle and its version, and nothing about the profile changes.
2. **Given** a profile pinning a setup bundle that has been archived, **When** an administrator enables it,
   **Then** the request is refused naming the archived bundle, and the disabled-bundle reason is not also
   reported for the same bundle.
3. **Given** a profile whose pinned workspace version holds no repositories, **When** an administrator enables
   it, **Then** the request is refused on the grounds that a run launched from it would have nothing to check
   out.
4. **Given** a profile with no published version, **When** an administrator enables it, **Then** the request is
   refused on those grounds rather than reported as an internal error.
5. **Given** a profile whose pinned bundle or workspace version can no longer be read, **When** an administrator
   enables it, **Then** the request is refused on those grounds rather than reported as an internal error.
6. **Given** a profile failing more than one retained check at once, **When** an administrator enables it,
   **Then** every failure is listed together rather than one per attempt.

---

### User Story 3 - A wrong repository is discovered at run time, clearly (Priority: P3)

An administrator mistypes a repository URL or names a branch that does not exist. The profile enables. The
first run launched from it fails during checkout with a message naming which entry failed, the repository, the
branch, and what the underlying tooling reported.

**Why this priority**: This is the failure mode the change deliberately accepts, so it must be verified rather
than assumed. It is P3 because the behaviour already exists and is already tested — this story confirms it is
the safety net, not that it needs building.

**Independent Test**: Launch a run whose workspace names a nonexistent repository and confirm the failure names
the entry and the repository, and that no partial workspace is left behind.

**Acceptance Scenarios**:

1. **Given** a run whose workspace names a repository that cannot be read, **When** the run reaches checkout,
   **Then** it fails naming the entry, the repository and the branch, and the agent is never started.
2. **Given** a run whose second repository fails after the first succeeded, **When** checkout unwinds, **Then**
   no partially built workspace remains.

---

### Edge Cases

- **A profile enabled before this change, whose repositories were never verified.** No profile can have been
  enabled through the gate, so there is no population of profiles carrying a stale reachability verdict. Any
  enabled profile in an existing deployment was enabled by other means and is unaffected.
- **A repository that becomes unreachable after the profile is enabled.** Out of scope before and after: the
  gate only ever ran at enable time, so a credential that expires or access that is revoked was always
  discovered at run time. This change does not widen that gap.
- **A disable request on a profile that fails the retained checks.** Disabling must remain unconditional — an
  administrator must always be able to take a broken profile out of circulation, and a gate on the way out
  would trap it in service.
- **An administrator reading a refusal that quotes the old wording.** Saved links, tickets and screenshots may
  quote `E_PROFILE_ENABLE_WORKSPACE_ENTRY`. That code disappears; the panel must degrade any refusal wording it
  does not recognise to a generic, actionable entry rather than dropping the line.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The platform MUST NOT verify, at profile-enable time, that a workspace entry's repository or base
  branch can be read.
- **FR-002**: The platform MUST NOT require any deployment-supplied repository-checking capability in order for
  an execution profile to be enabled. A deployment that supplies nothing beyond its current configuration MUST
  be able to enable profiles.
- **FR-003**: The enable gate MUST continue to refuse a profile that has no published version.
- **FR-004**: The enable gate MUST continue to refuse a profile whose pinned setup bundle version or workspace
  version can no longer be read.
- **FR-005**: The enable gate MUST continue to refuse a profile whose pinned setup bundle is disabled or
  archived, reporting archival in preference to disablement when both are true of the same bundle.
- **FR-006**: The enable gate MUST continue to refuse a profile whose pinned workspace is archived, or whose
  pinned workspace version contains no repositories.
- **FR-007**: The enable gate MUST continue to report **every** retained failure in one refusal, each naming the
  element it concerns, rather than stopping at the first.
- **FR-008**: A refused enable MUST change nothing about the profile.
- **FR-009**: Disabling an execution profile MUST remain unconditional and MUST NOT run the enable gate.
- **FR-010**: The administrator interface MUST NOT offer `workspace_entry` as a refusal category, and MUST
  render any refusal line it cannot classify as a generic entry carrying its own text and a next action.
- **FR-011**: A successful enable MUST be recorded in the configuration audit trail against the profile version
  it was validated against, as it is today.
- **FR-012**: A run whose workspace names a repository or branch that cannot be read MUST continue to fail
  during checkout, naming the entry, the repository and the branch, and MUST NOT start the agent.

### Key Entities

- **Execution profile**: The saved launch preset. Carries an enabled/disabled state, which this change makes
  reachable.
- **Enable check**: The verdict returned when an administrator attempts to enable a profile — a pass, or a list
  of named failures. Its set of possible failure categories loses one member (`workspace_entry`) and keeps the
  rest.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An administrator can enable a correctly configured execution profile in a deployment that has been
  given no additional configuration, on the first attempt, 100% of the time. This is currently 0%.
- **SC-002**: Enabling a profile completes without any outbound call to a code host, so its duration does not
  vary with the number of repositories in the workspace or with network conditions.
- **SC-003**: All six retained refusal conditions still produce a refusal that names the failing element and
  states a next action; none of them is weakened or removed.
- **SC-004**: An administrator who launches a run from a profile naming a bad repository learns which entry is
  at fault from the run's own failure message, without reading logs or contacting an engineer.
- **SC-005**: No enable path in the platform reports a check the platform did not perform.

## Assumptions

- **The administrators entering repository URLs own the repositories.** This is a small internal tool used by a
  handful of administrators configuring repositories their own organisation controls. Typos are possible;
  adversarial or careless input is not the threat model.
- **A failed checkout is an acceptable cost.** The price of a wrong URL is one short-lived worker machine that
  fails during checkout instead of a refusal at configuration time. At this tool's scale that is cheaper than
  building and operating a verification path.
- **The existing checkout failure message is good enough to be the safety net.** It already names the entry, the
  repository, the branch and the underlying error, and it already guarantees no partial workspace is left
  behind. This change relies on that and does not modify it.
- **The retained checks are worth keeping.** They need no network and no credential, they run against data the
  platform already holds, and each catches a real misconfiguration. Only the check that required a credential
  the platform cannot hold is withdrawn.
- **No deployment has wired a repository checker.** The capability was optional and no deployment supplies one,
  so removing it changes no deployment's behaviour other than by permitting enables that were previously
  refused.
- **Rejected alternatives.** Two ways to make the check real were considered and rejected as disproportionate:
  giving the platform its own code-host credential (which would verify with a _different_ credential from the
  one runs actually use, so it could pass while the run fails), and running the check on a worker machine as
  part of setup-bundle validation (correct, but a substantially larger build than this tool warrants).

## Out of Scope

- Introducing a platform-held code-host credential.
- Verifying repositories from a worker machine, whether during setup-bundle validation or otherwise.
- Any change to how the setup bundle installs repository-host credentials, or to the bundle archive contract.
- Any change to checkout behaviour, its failure messages, or its unwind guarantees.
- Re-validating the repositories of profiles that are already enabled.
