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
import { createRefusingReachabilityProbe } from './reachability'
import { createFakeReachabilityProbe } from './reachability-fake'

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
  it('passes when the bundle is enabled and every entry is reachable (FR-124)', async () => {
    const probe = createFakeReachabilityProbe()

    await expect(checkProfileCanBeEnabled(subject(), probe)).resolves.toStrictEqual({
      passed: true,
      failures: [],
    })

    // Both halves of the requirement were actually exercised: the branch is probed with the
    // repository, not just the repository.
    expect(probe.calls).toStrictEqual([
      { repositoryUrl: 'github.com/acme/api', baseBranch: 'main' },
      { repositoryUrl: 'github.com/acme/web', baseBranch: 'main' },
    ])
  })

  it('refuses a disabled setup bundle, naming it (FR-124)', async () => {
    const check = await checkProfileCanBeEnabled(
      subject({ setupBundleEnabled: false }),
      createFakeReachabilityProbe(),
    )

    expect(check.passed).toBe(false)
    expect(check.failures).toStrictEqual([
      {
        element: 'setup_bundle',
        detail:
          'the setup bundle acme-base (version 3) is disabled; enable it before enabling this profile',
      },
    ])
  })

  it('says an archived bundle is archived rather than merely disabled', async () => {
    const check = await checkProfileCanBeEnabled(
      subject({ setupBundleEnabled: false, setupBundleArchived: true }),
      createFakeReachabilityProbe(),
    )

    // One problem, stated once. An archived bundle is always disabled too, so reporting both
    // would send the admin to enable something that cannot be enabled.
    expect(check.failures).toHaveLength(1)
    expect(check.failures[0]?.detail).toContain('has been archived')
  })

  it('names the failing workspace entry, its repository and its branch (FR-124)', async () => {
    const probe = createFakeReachabilityProbe()
    probe.setOutcome('github.com/acme/web', {
      reachable: false,
      reason: 'the credential cannot read this repository',
    })

    const check = await checkProfileCanBeEnabled(subject(), probe)

    // "The profile cannot be enabled" would leave an admin comparing a dozen repositories by eye.
    expect(check.failures).toStrictEqual([
      {
        element: 'workspace_entry',
        detail:
          'workspace entry 2 (github.com/acme/web on main) is unreachable: the credential cannot read this repository',
      },
    ])
  })

  it('reports every failing entry rather than stopping at the first', async () => {
    const probe = createFakeReachabilityProbe({
      defaultOutcome: { reachable: false, reason: 'branch not found' },
    })

    const check = await checkProfileCanBeEnabled(subject(), probe)

    expect(check.failures).toHaveLength(2)
    expect(check.failures.map((failure) => failure.detail)).toStrictEqual([
      'workspace entry 1 (github.com/acme/api on main) is unreachable: branch not found',
      'workspace entry 2 (github.com/acme/web on main) is unreachable: branch not found',
    ])
  })

  it('reports a disabled bundle and an unreachable entry together', async () => {
    const probe = createFakeReachabilityProbe()
    probe.setOutcome('github.com/acme/api', { reachable: false, reason: 'host did not resolve' })

    const check = await checkProfileCanBeEnabled(subject({ setupBundleEnabled: false }), probe)

    expect(check.failures.map((failure) => failure.element)).toStrictEqual([
      'setup_bundle',
      'workspace_entry',
    ])
  })

  it('refuses a workspace version with no repositories, and probes nothing', async () => {
    const probe = createFakeReachabilityProbe()

    const check = await checkProfileCanBeEnabled(subject({ entries: [] }), probe)

    expect(check.failures).toHaveLength(1)
    expect(check.failures[0]).toMatchObject({ element: 'workspace_version' })
    expect(check.failures[0]?.detail).toContain('contains no repositories')
    expect(probe.calls).toStrictEqual([])
  })

  it('refuses an archived workspace', async () => {
    const check = await checkProfileCanBeEnabled(
      subject({ workspaceArchived: true }),
      createFakeReachabilityProbe(),
    )

    expect(check.failures.map((failure) => failure.element)).toStrictEqual(['workspace_version'])
    expect(check.failures[0]?.detail).toContain('platform')
  })

  it('refuses everything when no probe is configured, rather than passing unchecked', async () => {
    const check = await checkProfileCanBeEnabled(subject(), createRefusingReachabilityProbe())

    expect(check.passed).toBe(false)
    expect(check.failures).toHaveLength(2)
    expect(check.failures[0]?.detail).toContain('no repository reachability checker')
  })

  it('treats a probe that throws as unreachable, naming the entry it happened on', async () => {
    const probe = createFakeReachabilityProbe()
    probe.failWith('github.com/acme/api', new Error('the connection timed out'))

    const check = await checkProfileCanBeEnabled(subject(), probe)

    expect(check.failures).toStrictEqual([
      {
        element: 'workspace_entry',
        detail:
          'workspace entry 1 (github.com/acme/api on main) is unreachable: the connection timed out',
      },
    ])
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
  it('reports a missing attachment and a broken repository in one attempt', async () => {
    const probe = createFakeReachabilityProbe()
    probe.setOutcome('github.com/acme/web', { reachable: false, reason: 'the repository has gone' })

    const merged = mergeProfileEnableChecks(
      credentialGroupAttachmentCheck([]),
      await checkProfileCanBeEnabled(subject(), probe),
    )

    expect(merged.passed).toBe(false)
    expect(merged.failures.map((failure) => failure.element)).toStrictEqual([
      'credential_group',
      'workspace_entry',
    ])
  })

  it('passes only when every part passes', async () => {
    const merged = mergeProfileEnableChecks(
      credentialGroupAttachmentCheck([attachedGroup()]),
      await checkProfileCanBeEnabled(subject(), createFakeReachabilityProbe()),
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
    expect(unreadableSubjectCheck().failures[0]?.detail).toContain('could not be read')
  })
})

describe('profileCannotBeEnabledError', () => {
  it('is CONFLICT — the admin may act, the target’s state is wrong', async () => {
    const check = await checkProfileCanBeEnabled(
      subject({ setupBundleEnabled: false }),
      createFakeReachabilityProbe(),
    )

    expect(profileCannotBeEnabledError(check).code).toBe('CONFLICT')
  })

  it('lists every failure, one per line, so three broken entries take one attempt', async () => {
    const probe = createFakeReachabilityProbe({
      defaultOutcome: { reachable: false, reason: 'branch not found' },
    })
    const check = await checkProfileCanBeEnabled(subject({ setupBundleEnabled: false }), probe)

    const lines = profileCannotBeEnabledError(check).message.split('\n')

    expect(lines[0]).toBe('This execution profile cannot be enabled yet:')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toContain('acme-base')
    expect(lines[2]).toContain('workspace entry 1 (github.com/acme/api on main)')
    expect(lines[3]).toContain('workspace entry 2 (github.com/acme/web on main)')
  })
})
