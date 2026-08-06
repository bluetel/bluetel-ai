import { describe, expect, it } from 'vitest'

import type { WorkspaceEntry } from '../../db'

import {
  checkProfileCanBeEnabled,
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
