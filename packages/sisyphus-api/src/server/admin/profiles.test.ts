import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  configurationAudit,
  executionProfiles,
  executionProfileVersions,
  setupBundles,
  setupBundleVersions,
  workflows,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { UserRole } from '../../enums'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import { findProfileVersion } from './profile-store'
import { profilesRouter, profileTargetNotFoundError } from './profiles'
import { createGate, createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * The refusal a call produced.
 *
 * Used instead of `expect.stringContaining` inside `toMatchObject`, which is typed `any` and so
 * turns a message assertion into an unchecked one — and this suite's whole point is what the
 * messages say.
 */
const refusalOf = async (attempt: Promise<unknown>): Promise<TRPCError> => {
  try {
    await attempt
  } catch (error) {
    if (error instanceof TRPCError) {
      return error
    }
    throw error
  }

  throw new Error('Expected the call to be refused, but it succeeded.')
}

interface CallerIdentity {
  readonly id: string
  readonly email: string
  readonly role: UserRole
}

/** A context carrying one signed-in human, built exactly as `createSisyphusAdditionalContext` does. */
const contextFor = (
  db: SisyphusDatabase,
  user: CallerIdentity,
  denials: AuthorisationDenial[],
): SisyphusContext => {
  const session: SisyphusSession = {
    user: { ...user, displayName: user.email, isActive: true },
    expiresAt: new Date(Date.now() + 60_000),
  }

  return {
    headers: new Headers(),
    dependencies: {
      db,
      resolveSession: () => Promise.resolve(session),
      resolveMachineCredential: () => Promise.resolve(null),
      recordDenial: (denial) => {
        denials.push(denial)
        return Promise.resolve()
      },
    },
    db,
    session,
    scope: memoiseScope(() =>
      Promise.resolve({ userId: user.id, isAdmin: user.role === 'admin', visibleProfileIds: [] }),
    ),
    machineCredential: () => Promise.resolve(null),
  }
}

describe('the admin.profiles contract', () => {
  it('exposes exactly the procedures api-surface.md names', () => {
    expect(Object.keys(profilesRouter._def.procedures).sort()).toStrictEqual([
      'clone',
      'create',
      'list',
      'references',
      'setEnabled',
      'update',
    ])
  })

  it('makes `list` and `references` queries and every write a mutation', () => {
    const procedures = profilesRouter._def.procedures
    expect(procedures.list._def.type).toBe('query')
    expect(procedures.references._def.type).toBe('query')
    expect(procedures.create._def.type).toBe('mutation')
    expect(procedures.update._def.type).toBe('mutation')
    expect(procedures.clone._def.type).toBe('mutation')
    expect(procedures.setEnabled._def.type).toBe('mutation')
  })
})

describe('profileTargetNotFoundError', () => {
  it('is NOT_FOUND, never FORBIDDEN — FORBIDDEN would confirm the id exists (FR-190)', () => {
    expect(profileTargetNotFoundError().code).toBe('NOT_FOUND')
  })

  it('does not say which of the three ids was the missing one', () => {
    expect(profileTargetNotFoundError().message).toBe(
      'No such execution profile, workspace version or setup bundle version.',
    )
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

/**
 * The router against a real Postgres, on a private scratch database. Skipped — not failed —
 * without `SISYPHUS_TEST_DATABASE_URL`.
 *
 * The router mounted here is the one production mounts. Nothing is substituted for it: the enable
 * gate makes no outbound call, so there is no seam left to fake, and a test that exercised a
 * differently-wired router than the deployment would be the exact hazard this feature removed.
 */
describe.skipIf(liveDatabaseUrl === undefined)('admin.profiles against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
  const denials: AuthorisationDenial[] = []

  let admin: CallerIdentity
  let engineer: CallerIdentity

  /**
   * Built here rather than in `beforeAll` so the router's inferred procedure types survive: a
   * router held in an annotated `let` loses them, and the caller's methods stop being type-checked
   * against their inputs — which is most of what a contract test is for.
   */
  const createCaller = createCallerFactory(profilesRouter)

  /** Ids seeded once and shared: an enabled bundle version and a two-entry workspace version. */
  let enabledBundleVersionId = ''
  let disabledBundleVersionId = ''
  let workspaceVersionId = ''
  let emptyWorkspaceVersionId = ''
  let nonexistentRepoWorkspaceVersionId = ''

  const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials))
  const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials))

  const launchValues = () => ({
    workspaceVersionId,
    setupBundleVersionId: enabledBundleVersionId,
    model: 'claude-sonnet-5' as const,
    instanceType: 'm7i.xlarge',
    purchaseMode: 'on_demand' as const,
    turnCap: 40,
    spendCap: '25.0000',
    defaultWorkflowType: 'delegated' as const,
    promptPreamble: 'House style applies.',
    lockedFields: ['model' as const],
  })

  const auditFor = async (executionProfileId: string) =>
    fixtures
      .db()
      .select()
      .from(configurationAudit)
      .where(
        and(
          eq(configurationAudit.entityType, 'execution_profile'),
          eq(configurationAudit.entityId, executionProfileId),
        ),
      )

  const seedBundleVersion = async (label: string, enabled: boolean): Promise<string> => {
    const [bundle] = await fixtures
      .db()
      .insert(setupBundles)
      .values({
        name: `${label}-${fixtures.suffix}`,
        enabled,
        createdByUserId: admin.id,
      })
      .returning({ id: setupBundles.id })

    const [version] = await fixtures
      .db()
      .insert(setupBundleVersions)
      .values({
        setupBundleId: bundle.id,
        version: 1,
        s3Key: `fixtures/${label}-${fixtures.suffix}.tar.gz`,
        contentDigest: 'a'.repeat(64),
        sizeBytes: 1,
        registeredByUserId: admin.id,
      })
      .returning({ id: setupBundleVersions.id })

    return version.id
  }

  const seedWorkspaceVersion = async (
    label: string,
    repositories: readonly string[],
  ): Promise<string> => {
    const [workspace] = await fixtures
      .db()
      .insert(workspaces)
      .values({ name: `${label}-${fixtures.suffix}` })
      .returning({ id: workspaces.id })

    const [version] = await fixtures
      .db()
      .insert(workspaceVersions)
      .values({ workspaceId: workspace.id, version: 1, createdByUserId: admin.id })
      .returning({ id: workspaceVersions.id })

    if (repositories.length > 0) {
      await fixtures
        .db()
        .insert(workspaceEntries)
        .values(
          repositories.map((repositoryUrl, index) => ({
            workspaceVersionId: version.id,
            repositoryUrl,
            baseBranch: 'main',
            subdirectory: repositoryUrl.split('/').pop() ?? `repo-${String(index)}`,
            isPrimary: index === 0,
            position: index + 1,
          })),
        )
    }

    return version.id
  }

  /**
   * A run pinned to one profile version, exactly as `workflow.start` writes it.
   *
   * Inserted directly rather than through `workflow.start`: this suite is about profiles, and
   * reaching for the launch path to build a fixture would make a failure there look like one here.
   */
  const seedRunPinnedTo = async (
    executionProfileId: string,
    executionProfileVersionId: string,
  ): Promise<string> => {
    const [workflow] = await fixtures
      .db()
      .insert(workflows)
      .values({
        type: 'delegated',
        state: 'running',
        ownerUserId: admin.id,
        executionProfileId,
        executionProfileVersionId,
        setupBundleVersionId: enabledBundleVersionId,
        workspaceVersionId,
        model: 'claude-sonnet-5',
        instanceType: 'm7i.xlarge',
        purchaseMode: 'on_demand',
        sessionId: randomUUID(),
      })
      .returning({ id: workflows.id })

    return workflow.id
  }

  beforeAll(async () => {
    await fixtures.open()
    const seededAdmin = await fixtures.seedUser({ label: 'profile-admin', role: 'admin' })
    const seededEngineer = await fixtures.seedUser({ label: 'profile-engineer' })
    admin = { ...seededAdmin, role: 'admin' }
    engineer = { ...seededEngineer, role: 'engineer' }

    enabledBundleVersionId = await seedBundleVersion('profiles-enabled-bundle', true)
    disabledBundleVersionId = await seedBundleVersion('profiles-disabled-bundle', false)
    workspaceVersionId = await seedWorkspaceVersion('profiles-workspace', [
      'github.com/acme/api',
      'github.com/acme/web',
    ])
    emptyWorkspaceVersionId = await seedWorkspaceVersion('profiles-empty-workspace', [])
    // A repository that certainly does not exist. The gate must not care — see the enable test
    // that uses it.
    nonexistentRepoWorkspaceVersionId = await seedWorkspaceVersion('profiles-nonexistent-repo', [
      `github.com/acme/does-not-exist-${fixtures.suffix}`,
    ])
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  it('refuses every procedure to a non-admin and records the denial (FR-127, FR-169)', async () => {
    denials.length = 0
    const caller = asEngineer()

    await expect(
      caller.list({ enabledOnly: false, includeArchived: false, limit: 50 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      caller.setEnabled({ executionProfileId: randomUUID(), enabled: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(denials.map((denial) => denial.reason)).toStrictEqual(['not_admin', 'not_admin'])
  })

  it('creates a profile disabled, at version 1, holding every launch value (FR-121)', async () => {
    const created = await asAdmin().create({
      ...launchValues(),
      name: `alpha-${fixtures.suffix}`,
      description: 'The platform preset.',
    })

    expect(created.profile.enabled).toBe(false)
    expect(created.version.version).toBe(1)
    expect(created.profile.currentVersionId).toBe(created.version.id)
    expect(created.version).toMatchObject({
      workspaceVersionId,
      setupBundleVersionId: enabledBundleVersionId,
      model: 'claude-sonnet-5',
      instanceType: 'm7i.xlarge',
      turnCap: 40,
      defaultWorkflowType: 'delegated',
      promptPreamble: 'House style applies.',
      lockedFields: ['model'],
    })

    const trail = await auditFor(created.profile.id)
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      action: 'registered',
      actorUserId: admin.id,
      entityVersion: 1,
    })
  })

  it('refuses a version that pins ids which do not exist, without saying which (FR-190)', async () => {
    await expect(
      asAdmin().create({
        ...launchValues(),
        workspaceVersionId: randomUUID(),
        name: `nowhere-${fixtures.suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      asAdmin().create({
        ...launchValues(),
        setupBundleVersionId: randomUUID(),
        name: `nowhere-${fixtures.suffix}`,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a duplicate name', async () => {
    await expect(
      asAdmin().create({ ...launchValues(), name: `alpha-${fixtures.suffix}` }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('enables a profile pinning an enabled bundle and a non-empty workspace (FR-124)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((item) => item.name === `alpha-${fixtures.suffix}`)

    const result = await asAdmin().setEnabled({
      executionProfileId: alpha?.id ?? '',
      enabled: true,
    })

    expect(result.profile.enabled).toBe(true)
    expect(result.check?.passed).toBe(true)

    const enablement = (await auditFor(alpha?.id ?? '')).find((row) => row.action === 'enabled')
    expect(enablement?.detail).toMatchObject({
      validatedAgainstVersionId: expect.any(String) as unknown as string,
    })

    const actions = (await auditFor(alpha?.id ?? '')).map((row) => row.action).sort()
    expect(actions).toStrictEqual(['enabled', 'registered'])
  })

  it('enables a profile whose workspace names a repository that does not exist', async () => {
    // The platform makes no attempt to verify the repository. It cannot: the credential that could
    // read it is installed by the setup bundle onto the executor instance and never leaves it. A
    // bad URL is caught at bootstrap phase 6, which fails the run naming the entry (FR-112).
    const created = await asAdmin().create({
      ...launchValues(),
      workspaceVersionId: nonexistentRepoWorkspaceVersionId,
      name: `nonexistent-repo-${fixtures.suffix}`,
    })

    const result = await asAdmin().setEnabled({
      executionProfileId: created.profile.id,
      enabled: true,
    })

    expect(result.profile.enabled).toBe(true)
    expect(result.check?.passed).toBe(true)
  })

  it('re-enabling an already-enabled profile succeeds and writes no second audit entry', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((item) => item.name === `alpha-${fixtures.suffix}`)
    const before = (await auditFor(alpha?.id ?? '')).length

    const result = await asAdmin().setEnabled({
      executionProfileId: alpha?.id ?? '',
      enabled: true,
    })

    expect(result.profile.enabled).toBe(true)
    expect(result.check?.passed).toBe(true)
    // Nothing changed, and a trail padded with non-events is harder to read.
    expect(await auditFor(alpha?.id ?? '')).toHaveLength(before)
  })

  it('refuses to enable against a disabled setup bundle, naming it (FR-124)', async () => {
    const created = await asAdmin().create({
      ...launchValues(),
      setupBundleVersionId: disabledBundleVersionId,
      name: `mismatched-${fixtures.suffix}`,
    })

    const refusal = await refusalOf(
      asAdmin().setEnabled({ executionProfileId: created.profile.id, enabled: true }),
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain(`profiles-disabled-bundle-${fixtures.suffix}`)

    // Refused means refused: the flag did not move, so the mismatch cannot reach a run.
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    expect(page.items.find((item) => item.id === created.profile.id)?.enabled).toBe(false)
  })

  it('refuses to enable a profile whose workspace version has no repositories', async () => {
    const created = await asAdmin().create({
      ...launchValues(),
      workspaceVersionId: emptyWorkspaceVersionId,
      name: `empty-${fixtures.suffix}`,
    })

    const refusal = await refusalOf(
      asAdmin().setEnabled({ executionProfileId: created.profile.id, enabled: true }),
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('contains no repositories')

    // Refused means refused: the flag did not move.
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    expect(page.items.find((item) => item.id === created.profile.id)?.enabled).toBe(false)
  })

  it('never gates disabling — a profile that could not be enabled must still be withdrawable', async () => {
    // FR-009: the escape hatch stays open. Built on the empty-workspace profile precisely because
    // it is one the gate currently refuses to enable — disabling must not consult the gate at all.
    const created = await asAdmin().create({
      ...launchValues(),
      workspaceVersionId: emptyWorkspaceVersionId,
      name: `disable-always-allowed-${fixtures.suffix}`,
    })

    const result = await asAdmin().setEnabled({
      executionProfileId: created.profile.id,
      enabled: false,
    })

    expect(result.profile.enabled).toBe(false)
    expect(result.check).toBeUndefined()
  })

  /**
   * FR-125 on the profile side: a run pins `execution_profile_version_id`, and that row is what
   * reconstructs its configuration afterwards. An edit must leave it alone.
   */
  it('publishes a new version on edit and leaves the previous one intact (FR-125)', async () => {
    const created = await asAdmin().create({
      ...launchValues(),
      name: `versioned-${fixtures.suffix}`,
    })

    const edited = await asAdmin().update({
      ...launchValues(),
      executionProfileId: created.profile.id,
      instanceType: 'm7i.4xlarge',
      turnCap: 80,
    })

    expect(edited.version.version).toBe(2)
    expect(edited.version.id).not.toBe(created.version.id)
    expect(edited.profile.currentVersionId).toBe(edited.version.id)

    const versions = await fixtures
      .db()
      .select()
      .from(executionProfileVersions)
      .where(eq(executionProfileVersions.executionProfileId, created.profile.id))
      .orderBy(executionProfileVersions.version)

    expect(versions.map((row) => row.version)).toStrictEqual([1, 2])
    // Version 1 still says what the run that pinned it was launched with.
    expect(versions[0]).toMatchObject({ instanceType: 'm7i.xlarge', turnCap: 40 })
    expect(versions[1]).toMatchObject({ instanceType: 'm7i.4xlarge', turnCap: 80 })

    const trail = await auditFor(created.profile.id)
    expect(trail.map((row) => row.action).sort()).toStrictEqual(['registered', 'replaced'])
  })

  /**
   * **FR-125's actual claim on the profile side: "an in-flight workflow MUST be unaffected."**
   *
   * The test above is sequential — create, edit, assert — so it proves versions are append-only and
   * nothing more. Append-only is the weaker property: an implementation with no concurrency safety
   * at all satisfies it, because at no point does it have two transactions open. FR-125 is a
   * statement about an edit that lands *while a run is in flight*, and the only honest way to test
   * that is to make the two overlap.
   *
   * The run below holds its transaction open on `findProfileVersion` — the resolver that
   * reconstructs its configuration — while an admin's edit publishes version 2 and commits inside
   * that window. What makes the pass mean something is the same three things the workspace suite
   * relies on: Postgres reports the run's backend `idle in transaction`; the run is provably still
   * unsettled when the edit returns; and the run's second read **sees** the edit — the parent row
   * has moved on to version 2 — while its own pinned version row is unchanged. Absent that last
   * assertion, an isolated snapshot would explain the result just as well as an immutable version.
   */
  it('leaves a run’s pinned version untouched by an edit landing mid-run (FR-125)', async () => {
    const created = await asAdmin().create({
      ...launchValues(),
      name: `mid-run-${fixtures.suffix}`,
    })

    const pinnedVersionId = created.version.id
    const workflowId = await seedRunPinnedTo(created.profile.id, pinnedVersionId)

    const running = createGate()
    const editLanded = createGate()
    let runSettled = false

    const run = fixtures
      .db()
      .transaction(async (tx) => {
        const atLaunch = await findProfileVersion(tx, pinnedVersionId)
        running.open()
        await editLanded.opened

        const afterEdit = await findProfileVersion(tx, pinnedVersionId)
        const [parent] = await tx
          .select({ currentVersionId: executionProfiles.currentVersionId })
          .from(executionProfiles)
          .where(eq(executionProfiles.id, created.profile.id))

        return { atLaunch, afterEdit, currentVersionId: parent.currentVersionId }
      })
      .finally(() => {
        runSettled = true
      })

    await running.opened
    expect(await fixtures.backendsInTransaction()).toBeGreaterThan(0)

    // The edit lands inside the run's window, and disagrees with version 1 about every value a
    // run's configuration is reconstructed from.
    const edited = await asAdmin().update({
      ...launchValues(),
      executionProfileId: created.profile.id,
      instanceType: 'm7i.8xlarge',
      turnCap: 400,
      spendCap: '900.0000',
      promptPreamble: 'Rewritten house style.',
      lockedFields: [],
    })

    expect(edited.version.version).toBe(2)
    expect(runSettled).toBe(false)

    editLanded.open()
    const observed = await run

    // The run saw the edit — the parent row moved on — so nothing below is a snapshot hiding it.
    expect(observed.currentVersionId).toBe(edited.version.id)
    expect(observed.currentVersionId).not.toBe(pinnedVersionId)

    // And the version it launched under is the same row, value for value.
    expect(observed.afterEdit).toStrictEqual(observed.atLaunch)
    expect(observed.afterEdit).toMatchObject({
      id: pinnedVersionId,
      version: 1,
      instanceType: 'm7i.xlarge',
      turnCap: 40,
      promptPreamble: 'House style applies.',
      lockedFields: ['model'],
    })

    // The pin on the run itself did not move either, and resolving through it still answers with
    // version 1 now that everything has committed.
    const [workflow] = await fixtures
      .db()
      .select({ executionProfileVersionId: workflows.executionProfileVersionId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
    expect(workflow.executionProfileVersionId).toBe(pinnedVersionId)

    const resolved = await findProfileVersion(fixtures.db(), pinnedVersionId)
    expect(resolved).toMatchObject({ instanceType: 'm7i.xlarge', turnCap: 40 })
  }, 30_000)

  it('clones the current version into a new, disabled profile with no grants (FR-127)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const source = page.items.find((item) => item.name === `versioned-${fixtures.suffix}`)

    const cloned = await asAdmin().clone({
      executionProfileId: source?.id ?? '',
      name: `cloned-${fixtures.suffix}`,
    })

    expect(cloned.profile.enabled).toBe(false)
    expect(cloned.version.version).toBe(1)
    expect(cloned.version.instanceType).toBe('m7i.4xlarge')
    expect(cloned.version.lockedFields).toStrictEqual(['model'])

    const references = await asAdmin().references({ executionProfileId: cloned.profile.id })
    expect(references.liveGrantCount).toBe(0)
  })

  it('reports an unknown profile identically across every procedure (FR-190)', async () => {
    const caller = asAdmin()
    const expected = {
      code: 'NOT_FOUND',
      message: 'No such execution profile, workspace version or setup bundle version.',
    }

    await expect(caller.references({ executionProfileId: randomUUID() })).rejects.toMatchObject(
      expected,
    )
    await expect(
      caller.setEnabled({ executionProfileId: randomUUID(), enabled: true }),
    ).rejects.toMatchObject(expected)
    await expect(
      caller.clone({ executionProfileId: randomUUID(), name: `nope-${fixtures.suffix}` }),
    ).rejects.toMatchObject(expected)
    await expect(
      caller.update({ ...launchValues(), executionProfileId: randomUUID() }),
    ).rejects.toMatchObject(expected)
  })

  it('reports a profile nothing references as archivable (FR-128)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((item) => item.name === `alpha-${fixtures.suffix}`)

    await expect(
      asAdmin().references({ executionProfileId: alpha?.id ?? '' }),
    ).resolves.toStrictEqual({
      integrations: [],
      activeWorkflowCount: 0,
      totalWorkflowCount: 0,
      liveGrantCount: 0,
      archivable: true,
    })
  })
})
