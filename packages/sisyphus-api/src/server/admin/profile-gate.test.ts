import { describe, expect, it } from 'vitest'

import type { WorkspaceEntry } from '../../db'

import type { AttachedCredentialGroup } from './profile-gate'
import {
  checkProfileCanBeEnabled,
  credentialGroupAttachmentCheck,
  mergeProfileEnableChecks,
  noPublishedVersionCheck,
  profileCannotBeEnabledError,
  unreadableSubjectCheck,
} from './profile-gate'
import type { ProfileEnableSubject } from './profile-store'

/**
 * Every retained refusal is asserted against a **known failure** — a subject constructed to violate
 * exactly that condition — rather than inferred from a passing case. A gate is only trusted once it
 * has been seen to bite, and this gate previously shipped with a half that refused everything
 * unconditionally without any suite noticing that the product had become unusable.
 */

const workspaceEntry = (repositoryUrl: string, position: number): WorkspaceEntry => ({
  id: `entry-${String(position)}`,
  workspaceVersionId: 'workspace-version',
  repositoryUrl,
  baseBranch: 'main',
  subdirectory: repositoryUrl.split('/').pop() ?? 'repo',
  isPrimary: position === 1,
  position,
  createdAt: new Date(),
})

const subject = (overrides: Partial<ProfileEnableSubject> = {}): ProfileEnableSubject => ({
  setupBundleName: 'acme-base',
  setupBundleVersion: 3,
  setupBundleEnabled: true,
  setupBundleArchived: false,
  workspaceName: 'platform',
  workspaceVersion: 2,
  workspaceArchived: false,
  entries: [workspaceEntry('github.com/acme/api', 1), workspaceEntry('github.com/acme/web', 2)],
  ...overrides,
})

describe('checkProfileCanBeEnabled', () => {
  it('passes a profile pinning an enabled bundle and a non-empty workspace (FR-124)', () => {
    expect(checkProfileCanBeEnabled(subject())).toStrictEqual({ passed: true, failures: [] })
  })

  it('does not inspect the repositories themselves', () => {
    // The entries are counted, never verified. Whether these repositories or branches exist is
    // settled at checkout by the credential that will do the cloning — the platform never holds
    // that credential, so a gate here could only ever guess.
    const check = checkProfileCanBeEnabled(
      subject({
        entries: [
          workspaceEntry('github.com/acme/does-not-exist', 1),
          workspaceEntry('not-even-a-url', 2),
        ],
      }),
    )

    expect(check).toStrictEqual({ passed: true, failures: [] })
  })

  it('refuses a disabled setup bundle, naming it (FR-124)', () => {
    const check = checkProfileCanBeEnabled(subject({ setupBundleEnabled: false }))

    expect(check.passed).toBe(false)
    expect(check.failures).toStrictEqual([
      {
        element: 'setup_bundle',
        detail:
          'the setup bundle acme-base (version 3) is disabled; enable it before enabling this profile',
      },
    ])
  })

  it('says an archived bundle is archived rather than merely disabled', () => {
    const check = checkProfileCanBeEnabled(
      subject({ setupBundleEnabled: false, setupBundleArchived: true }),
    )

    // One problem, stated once. An archived bundle is always disabled too, so reporting both
    // would send the admin to enable something that cannot be enabled.
    expect(check.failures).toHaveLength(1)
    expect(check.failures[0]?.detail).toContain('has been archived')
    expect(check.failures[0]?.detail).not.toContain('is disabled')
  })

  it('refuses an archived workspace, naming it', () => {
    const check = checkProfileCanBeEnabled(subject({ workspaceArchived: true }))

    expect(check.failures.map((failure) => failure.element)).toStrictEqual(['workspace_version'])
    expect(check.failures[0]?.detail).toContain('platform')
  })

  it('refuses a workspace version with no repositories', () => {
    // Not a formality: a run launched from this profile would provision a paid instance and reach
    // bootstrap phase 6 with nothing to check out.
    const check = checkProfileCanBeEnabled(subject({ entries: [] }))

    expect(check.failures).toHaveLength(1)
    expect(check.failures[0]).toMatchObject({ element: 'workspace_version' })
    expect(check.failures[0]?.detail).toContain('contains no repositories')
  })

  it('reports every failure together rather than stopping at the first', () => {
    // An admin fixing two broken things should not have to discover them one attempt at a time.
    const check = checkProfileCanBeEnabled(subject({ setupBundleEnabled: false, entries: [] }))

    expect(check.failures.map((failure) => failure.element)).toStrictEqual([
      'setup_bundle',
      'workspace_version',
    ])
  })

  it('reports an archived bundle and an archived workspace together', () => {
    const check = checkProfileCanBeEnabled(
      subject({ setupBundleEnabled: false, setupBundleArchived: true, workspaceArchived: true }),
    )

    expect(check.failures.map((failure) => failure.element)).toStrictEqual([
      'setup_bundle',
      'workspace_version',
    ])
  })

  it('keeps `passed` in step with `failures` in both directions', () => {
    expect(checkProfileCanBeEnabled(subject()).passed).toBe(true)
    expect(checkProfileCanBeEnabled(subject({ workspaceArchived: true })).passed).toBe(false)
  })
})

const attachedGroup = (
  overrides: Partial<AttachedCredentialGroup> = {},
): AttachedCredentialGroup => ({
  name: 'vendor pool',
  enabled: true,
  archivedAt: null,
  position: 1,
  ...overrides,
})

/**
 * 003/FR-065. Every assertion here is about the *timing* of the refusal as much as its content:
 * this check runs when a profile is being configured, which is the only moment at which the person
 * who can fix it is looking at it.
 */
describe('credentialGroupAttachmentCheck', () => {
  it('passes a profile attached to a usable group', () => {
    expect(credentialGroupAttachmentCheck([attachedGroup()])).toStrictEqual({
      passed: true,
      failures: [],
    })
  })

  it('refuses a profile with no attachment at all, naming what is missing (003/FR-065)', () => {
    const check = credentialGroupAttachmentCheck([])

    expect(check.passed).toBe(false)
    expect(check.failures).toHaveLength(1)
    expect(check.failures[0]?.element).toBe('credential_group')
    // Not "this profile cannot be enabled": an admin holding a form with a bundle, a workspace, a
    // dozen repositories and a group list needs to be told which of them is empty.
    expect(check.failures[0]?.detail).toContain('no attached credential group')
    expect(check.failures[0]?.detail).toContain('attach at least one group')
  })

  it('says why the refusal exists in terms of the run, not of the form', () => {
    // The failure a launch-time check would have produced — a run with no identity it may work as
    // — stated at the moment it can still be prevented.
    expect(credentialGroupAttachmentCheck([]).failures[0]?.detail).toContain(
      'no agent identity it is permitted to work as',
    )
  })

  it('refuses a profile whose every attached group is disabled, naming them', () => {
    const check = credentialGroupAttachmentCheck([
      attachedGroup({ name: 'retired pool', enabled: false }),
      attachedGroup({ name: 'other retired pool', enabled: false, position: 2 }),
    ])

    // "Has an attachment" and "can select a credential" are different properties, and a profile
    // with only disabled groups behaves at launch exactly like one with none.
    expect(check.passed).toBe(false)
    expect(check.failures[0]?.detail).toContain('retired pool, other retired pool')
    expect(check.failures[0]?.detail).toContain('unavailable')
  })

  it('refuses a profile whose every attached group is archived', () => {
    const check = credentialGroupAttachmentCheck([
      attachedGroup({ name: 'gone pool', archivedAt: new Date() }),
    ])

    expect(check.passed).toBe(false)
    expect(check.failures[0]?.element).toBe('credential_group')
  })

  it('distinguishes “attach one” from “re-enable the one you have”', () => {
    // Different fixes, so different sentences. One admin needs to attach a group, the other needs
    // to turn one back on, and a shared message would send both to the wrong screen.
    const none = credentialGroupAttachmentCheck([]).failures[0]?.detail ?? ''
    const disabled =
      credentialGroupAttachmentCheck([attachedGroup({ enabled: false })]).failures[0]?.detail ?? ''

    expect(none).not.toBe(disabled)
    expect(none).toContain('attach at least one group')
    expect(disabled).not.toContain('attach at least one group')
  })

  it('passes when one attached group is usable and another is not', () => {
    // Selection falls through to the next attached group in preference order, so one live group is
    // enough to make the profile launchable.
    expect(
      credentialGroupAttachmentCheck([
        attachedGroup({ name: 'retired pool', enabled: false }),
        attachedGroup({ name: 'live pool', position: 2 }),
      ]).passed,
    ).toBe(true)
  })
})

describe('mergeProfileEnableChecks', () => {
  it('reports a missing attachment and a disabled bundle in one attempt', () => {
    const merged = mergeProfileEnableChecks(
      credentialGroupAttachmentCheck([]),
      checkProfileCanBeEnabled(subject({ setupBundleEnabled: false })),
    )

    expect(merged.passed).toBe(false)
    expect(merged.failures.map((failure) => failure.element)).toStrictEqual([
      'credential_group',
      'setup_bundle',
    ])
  })

  it('passes only when every part passes', () => {
    const merged = mergeProfileEnableChecks(
      credentialGroupAttachmentCheck([attachedGroup()]),
      checkProfileCanBeEnabled(subject()),
    )

    expect(merged).toStrictEqual({ passed: true, failures: [] })
  })

  it('reports nothing as passing, so an empty gate cannot refuse', () => {
    expect(mergeProfileEnableChecks()).toStrictEqual({ passed: true, failures: [] })
  })
})

describe('the pre-gate verdicts', () => {
  it('refuses a profile with no published version', () => {
    const check = noPublishedVersionCheck()

    expect(check.passed).toBe(false)
    expect(check.failures[0]).toMatchObject({ element: 'profile_version' })
  })

  it('refuses a version whose pinned rows cannot be read', () => {
    const check = unreadableSubjectCheck()

    expect(check.passed).toBe(false)
    expect(check.failures[0]).toMatchObject({ element: 'profile_version' })
    expect(check.failures[0]?.detail).toContain('could not be read')
  })
})

describe('profileCannotBeEnabledError', () => {
  it('is CONFLICT — the admin may act, the target’s state is wrong', () => {
    const check = checkProfileCanBeEnabled(subject({ setupBundleEnabled: false }))

    expect(profileCannotBeEnabledError(check).code).toBe('CONFLICT')
  })

  it('lists every failure, one per line, so two broken things take one attempt', () => {
    const check = checkProfileCanBeEnabled(subject({ setupBundleEnabled: false, entries: [] }))

    const lines = profileCannotBeEnabledError(check).message.split('\n')

    expect(lines[0]).toBe('This execution profile cannot be enabled yet:')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('acme-base')
    expect(lines[2]).toContain('contains no repositories')
  })
})
