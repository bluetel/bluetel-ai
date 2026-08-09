import { describe, expect, it } from 'vitest'

import type { WorkspaceEntry } from '../../db'

import {
  checkProfileCanBeEnabled,
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
