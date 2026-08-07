import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  configurationAudit,
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

import { createGate, createUserFixtures, readTestDatabaseUrl } from './test-database'
import { readVersionEntries } from './workspace-store'
import { duplicateWorkspaceNameError, workspaceNotFoundError, workspacesRouter } from './workspaces'

const createCaller = createCallerFactory(workspacesRouter)

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

describe('the admin.workspaces contract', () => {
  it('exposes exactly the procedures api-surface.md names', () => {
    expect(Object.keys(workspacesRouter._def.procedures).sort()).toStrictEqual([
      'clone',
      'create',
      'list',
      'references',
      'setEnabled',
      'update',
    ])
  })

  it('makes `list` and `references` queries and every write a mutation', () => {
    const procedures = workspacesRouter._def.procedures
    expect(procedures.list._def.type).toBe('query')
    expect(procedures.references._def.type).toBe('query')
    expect(procedures.create._def.type).toBe('mutation')
    expect(procedures.update._def.type).toBe('mutation')
    expect(procedures.clone._def.type).toBe('mutation')
    expect(procedures.setEnabled._def.type).toBe('mutation')
  })
})

describe('workspaceNotFoundError', () => {
  it('is NOT_FOUND, never FORBIDDEN — FORBIDDEN would confirm the id exists (FR-190)', () => {
    expect(workspaceNotFoundError().code).toBe('NOT_FOUND')
  })

  it('does not say whether it was the workspace or the version that was missing', () => {
    expect(workspaceNotFoundError().message).toBe('No such workspace or workspace version.')
  })

  it('echoes only the caller’s own name back on a clash', () => {
    expect(duplicateWorkspaceNameError('platform').message).toContain('platform')
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

/**
 * The router against a real Postgres, on a private scratch database. Skipped — not failed —
 * without `SISYPHUS_TEST_DATABASE_URL`, so a plain `vitest run` stays green.
 */
describe.skipIf(liveDatabaseUrl === undefined)('admin.workspaces against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
  const denials: AuthorisationDenial[] = []

  let admin: CallerIdentity
  let engineer: CallerIdentity

  const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials))
  const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials))

  const entry = (overrides: Record<string, unknown> = {}) => ({
    repositoryUrl: 'github.com/acme/api',
    baseBranch: 'main',
    subdirectory: 'api',
    isPrimary: true,
    position: 1,
    ...overrides,
  })

  const auditFor = async (workspaceId: string) =>
    fixtures
      .db()
      .select()
      .from(configurationAudit)
      .where(
        and(
          eq(configurationAudit.entityType, 'workspace'),
          eq(configurationAudit.entityId, workspaceId),
        ),
      )

  const entriesOf = async (workspaceVersionId: string) =>
    fixtures
      .db()
      .select()
      .from(workspaceEntries)
      .where(eq(workspaceEntries.workspaceVersionId, workspaceVersionId))
      .orderBy(asc(workspaceEntries.position))

  /**
   * A setup bundle version, so a workflow row can exist. Inserted directly rather than through
   * `admin.bundles`: this suite is testing workspaces, and reaching for a second router to build a
   * fixture would make a failure there look like a failure here.
   */
  let bundleVersionId: string

  const seedBundleVersion = async (): Promise<string> => {
    const [bundle] = await fixtures
      .db()
      .insert(setupBundles)
      .values({ name: `workspace-suite-${fixtures.suffix}`, createdByUserId: admin.id })
      .returning({ id: setupBundles.id })

    const [version] = await fixtures
      .db()
      .insert(setupBundleVersions)
      .values({
        setupBundleId: bundle.id,
        version: 1,
        s3Key: `fixtures/${fixtures.suffix}.tar.gz`,
        contentDigest: 'a'.repeat(64),
        sizeBytes: 1,
        registeredByUserId: admin.id,
      })
      .returning({ id: setupBundleVersions.id })

    return version.id
  }

  /** A run pinned to one workspace version, exactly as `workflow.start` writes it. */
  const seedWorkflowPinnedTo = async (workspaceVersionId: string): Promise<string> => {
    const [workflow] = await fixtures
      .db()
      .insert(workflows)
      .values({
        type: 'delegated',
        state: 'running',
        ownerUserId: admin.id,
        setupBundleVersionId: bundleVersionId,
        workspaceVersionId,
        model: 'claude-sonnet-5',
        instanceType: 'fixture.small',
        purchaseMode: 'on_demand',
        sessionId: randomUUID(),
      })
      .returning({ id: workflows.id })

    return workflow.id
  }

  beforeAll(async () => {
    await fixtures.open()
    const seededAdmin = await fixtures.seedUser({ label: 'workspace-admin', role: 'admin' })
    const seededEngineer = await fixtures.seedUser({ label: 'workspace-engineer' })
    admin = { ...seededAdmin, role: 'admin' }
    engineer = { ...seededEngineer, role: 'engineer' }
    bundleVersionId = await seedBundleVersion()
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  it('refuses every procedure to a non-admin and records the denial (FR-127, FR-169)', async () => {
    denials.length = 0
    const caller = asEngineer()

    await expect(
      caller.create({ name: `refused-${fixtures.suffix}`, entries: [entry()] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      caller.list({ enabledOnly: false, includeArchived: false, limit: 50 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(caller.references({ workspaceId: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    expect(denials.map((denial) => denial.reason)).toStrictEqual([
      'not_admin',
      'not_admin',
      'not_admin',
    ])
  })

  it('creates a workspace disabled, at version 1, with the acting admin on the trail', async () => {
    const created = await asAdmin().create({
      name: `alpha-${fixtures.suffix}`,
      description: 'The platform workspace.',
      entries: [
        entry({ subdirectory: 'api', position: 1 }),
        entry({
          repositoryUrl: 'github.com/acme/web',
          subdirectory: 'web',
          isPrimary: false,
          position: 2,
        }),
      ],
    })

    expect(created.workspace.enabled).toBe(false)
    expect(created.published.version.version).toBe(1)
    expect(created.published.entries).toHaveLength(2)
    expect(created.workspace.currentVersionId).toBe(created.published.version.id)

    const entries = await entriesOf(created.published.version.id)
    expect(entries.map((row) => row.subdirectory)).toStrictEqual(['api', 'web'])
    expect(entries.filter((row) => row.isPrimary)).toHaveLength(1)

    const trail = await auditFor(created.workspace.id)
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      action: 'registered',
      actorUserId: admin.id,
      entityVersion: 1,
    })
  })

  it('stores the normalised subdirectory rather than what was typed (FR-111)', async () => {
    const created = await asAdmin().create({
      name: `normalised-${fixtures.suffix}`,
      entries: [entry({ subdirectory: './services/api/' })],
    })

    expect(created.published.entries[0]?.subdirectory).toBe('services/api')
  })

  it('refuses a subdirectory that escapes the workspace root, naming the entry (FR-111)', async () => {
    const refusal = await refusalOf(
      asAdmin().create({
        name: `escaping-${fixtures.suffix}`,
        entries: [entry({ subdirectory: '../elsewhere' })],
      }),
    )

    expect(refusal.code).toBe('BAD_REQUEST')
    expect(refusal.message).toContain('climbs above the workspace root')

    // Nothing was written: the entry list is normalised before the parent row is inserted.
    const rows = await fixtures
      .db()
      .select()
      .from(workspaces)
      .where(eq(workspaces.name, `escaping-${fixtures.suffix}`))
    expect(rows).toHaveLength(0)
  })

  it('refuses a duplicate name rather than silently versioning someone else’s workspace', async () => {
    await expect(
      asAdmin().create({ name: `alpha-${fixtures.suffix}`, entries: [entry()] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  /**
   * **The whole point of FR-125.**
   *
   * A run records `workflows.workspace_version_id` at launch and resolves its checkout through it
   * for the rest of its life. This asserts that an edit publishing version 2 leaves version 1's
   * entry rows byte-for-byte as they were — same ids, same repositories, including the one the edit
   * removed — so the run pinned to version 1 still resolves version 1.
   *
   * An implementation that updated `workspace_entries` in place would pass every other test in this
   * file and fail here, having silently changed what a running agent is working on.
   */
  it('leaves a running workflow on its pinned version after an edit publishes the next one (FR-125)', async () => {
    const created = await asAdmin().create({
      name: `pinned-${fixtures.suffix}`,
      entries: [
        entry({ repositoryUrl: 'github.com/acme/api', subdirectory: 'api', position: 1 }),
        entry({
          repositoryUrl: 'github.com/acme/legacy',
          subdirectory: 'legacy',
          isPrimary: false,
          position: 2,
        }),
      ],
    })

    const pinnedVersionId = created.published.version.id
    const entriesBefore = await entriesOf(pinnedVersionId)
    const workflowId = await seedWorkflowPinnedTo(pinnedVersionId)

    // The edit: `legacy` is dropped and `web` appears, so version 2 disagrees with version 1 about
    // both the number of repositories and their names.
    const edited = await asAdmin().update({
      workspaceId: created.workspace.id,
      entries: [
        entry({ repositoryUrl: 'github.com/acme/api', subdirectory: 'api', position: 1 }),
        entry({
          repositoryUrl: 'github.com/acme/web',
          subdirectory: 'web',
          isPrimary: false,
          position: 2,
        }),
      ],
    })

    expect(edited.published.version.version).toBe(2)
    expect(edited.published.version.id).not.toBe(pinnedVersionId)

    // 1. The pinned version's entries are untouched — same rows, same ids, same repositories.
    const entriesAfter = await entriesOf(pinnedVersionId)
    expect(entriesAfter).toStrictEqual(entriesBefore)
    expect(entriesAfter.map((row) => row.repositoryUrl)).toStrictEqual([
      'github.com/acme/api',
      'github.com/acme/legacy',
    ])

    // 2. The running workflow still points at it, and resolving through the pointer still yields
    //    the repository the edit removed.
    const [workflow] = await fixtures
      .db()
      .select({ workspaceVersionId: workflows.workspaceVersionId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
    expect(workflow.workspaceVersionId).toBe(pinnedVersionId)

    const resolved = await entriesOf(workflow.workspaceVersionId)
    expect(resolved.map((row) => row.repositoryUrl)).toContain('github.com/acme/legacy')

    // 3. And version 2 is what a *new* launch would pin.
    const [parent] = await fixtures
      .db()
      .select({ currentVersionId: workspaces.currentVersionId })
      .from(workspaces)
      .where(eq(workspaces.id, created.workspace.id))
    expect(parent.currentVersionId).toBe(edited.published.version.id)

    const trail = await auditFor(created.workspace.id)
    expect(trail.map((row) => row.action).sort()).toStrictEqual(['registered', 'replaced'])
    expect(trail.find((row) => row.action === 'replaced')).toMatchObject({ entityVersion: 2 })
  })

  /**
   * **FR-125's actual claim: "an in-flight workflow MUST be unaffected by an edit."**
   *
   * The test above is sequential — seed, edit, assert — and so proves only that versioning is
   * append-only. Append-only is a *weaker* property than the requirement: an implementation with no
   * concurrency safety whatsoever passes it, because nothing in it ever has two transactions open
   * at once. "In-flight" is a claim about overlap, and the only way to test overlap is to create it.
   *
   * So this holds the run's transaction open on the same `readVersionEntries` its checkout resolves
   * through, lands the edit **inside** that window, and only then lets the run continue. Three
   * things make the result mean something:
   *
   * 1. Postgres — not an unresolved promise — confirms the run's backend is `idle in transaction`
   *    while the edit runs. A promise that has not settled would also describe a transaction that
   *    never opened.
   * 2. The run is still unsettled when the edit returns, so the edit demonstrably landed *during*
   *    it rather than after it.
   * 3. The run's second read **sees** the edit — version 2 exists to it — and its own pinned entries
   *    are nevertheless the identical rows. Without that, a pass would be equally well explained by
   *    a snapshot that simply hid the edit, which is not the guarantee FR-125 makes.
   */
  it('is unaffected by an edit that lands while the run is in flight (FR-125)', async () => {
    const created = await asAdmin().create({
      name: `mid-run-${fixtures.suffix}`,
      entries: [
        entry({ repositoryUrl: 'github.com/acme/api', subdirectory: 'api', position: 1 }),
        entry({
          repositoryUrl: 'github.com/acme/legacy',
          subdirectory: 'legacy',
          isPrimary: false,
          position: 2,
        }),
      ],
    })

    const pinnedVersionId = created.published.version.id
    const workflowId = await seedWorkflowPinnedTo(pinnedVersionId)

    const running = createGate()
    const editLanded = createGate()
    let runSettled = false

    // The run: one transaction, open across the edit, resolving its checkout through the pinned
    // version exactly as the detail view and the executor do.
    const run = fixtures
      .db()
      .transaction(async (tx) => {
        const atLaunch = await readVersionEntries(tx, pinnedVersionId)
        running.open()
        await editLanded.opened

        const afterEdit = await readVersionEntries(tx, pinnedVersionId)
        const versionsVisible = await tx
          .select({ id: workspaceVersions.id })
          .from(workspaceVersions)
          .where(eq(workspaceVersions.workspaceId, created.workspace.id))

        return { atLaunch, afterEdit, versionsVisible: versionsVisible.length }
      })
      .finally(() => {
        runSettled = true
      })

    await running.opened
    expect(await fixtures.backendsInTransaction()).toBeGreaterThan(0)

    const edited = await asAdmin().update({
      workspaceId: created.workspace.id,
      entries: [
        entry({ repositoryUrl: 'github.com/acme/api', subdirectory: 'api', position: 1 }),
        entry({
          repositoryUrl: 'github.com/acme/web',
          subdirectory: 'web',
          isPrimary: false,
          position: 2,
        }),
      ],
    })

    expect(edited.published.version.version).toBe(2)
    // The edit committed while the run was still inside its transaction — this is the overlap.
    expect(runSettled).toBe(false)

    editLanded.open()
    const observed = await run

    // The run can see the edit, so nothing below is explained by an isolated snapshot…
    expect(observed.versionsVisible).toBe(2)
    // …and its own entries are the same rows regardless: same ids, same repositories, same order.
    expect(observed.afterEdit).toStrictEqual(observed.atLaunch)
    expect(observed.afterEdit.map((row) => row.repositoryUrl)).toStrictEqual([
      'github.com/acme/api',
      'github.com/acme/legacy',
    ])

    // The pin itself did not move, and resolving through it still yields the removed repository.
    const [workflow] = await fixtures
      .db()
      .select({ workspaceVersionId: workflows.workspaceVersionId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
    expect(workflow.workspaceVersionId).toBe(pinnedVersionId)
    expect(
      (await readVersionEntries(fixtures.db(), workflow.workspaceVersionId)).map(
        (row) => row.repositoryUrl,
      ),
    ).toContain('github.com/acme/legacy')
  }, 30_000)

  it('lists the current version and its entries, not the newest version number', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const pinned = page.items.find((item) => item.name === `pinned-${fixtures.suffix}`)

    expect(pinned?.currentVersion?.version).toBe(2)
    expect(pinned?.versionCount).toBe(2)
    expect(pinned?.currentVersion?.entries.map((item) => item.subdirectory)).toStrictEqual([
      'api',
      'web',
    ])
  })

  it('clones the current version into a new, disabled workspace at version 1 (FR-127)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const source = page.items.find((item) => item.name === `pinned-${fixtures.suffix}`)

    const cloned = await asAdmin().clone({
      workspaceId: source?.id ?? '',
      name: `cloned-${fixtures.suffix}`,
    })

    expect(cloned.workspace.enabled).toBe(false)
    expect(cloned.published.version.version).toBe(1)
    expect(cloned.published.entries.map((item) => item.subdirectory)).toStrictEqual(['api', 'web'])
    // A copy, not a reference: the clone's entries are its own rows.
    expect(cloned.published.entries.map((item) => item.id)).not.toStrictEqual(
      source?.currentVersion?.entries.map((item) => item.id),
    )
  })

  it('records enable and disable, and writes nothing for a no-op', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const target = page.items.find((item) => item.name === `alpha-${fixtures.suffix}`)
    const workspaceId = target?.id ?? ''

    expect((await asAdmin().setEnabled({ workspaceId, enabled: true })).enabled).toBe(true)
    await asAdmin().setEnabled({ workspaceId, enabled: true })
    expect((await asAdmin().setEnabled({ workspaceId, enabled: false })).enabled).toBe(false)

    const actions = (await auditFor(workspaceId)).map((row) => row.action).sort()
    expect(actions).toStrictEqual(['disabled', 'enabled', 'registered'])
  })

  it('reports an unknown workspace and an unknown version identically (FR-190)', async () => {
    const caller = asAdmin()
    const expected = { code: 'NOT_FOUND', message: 'No such workspace or workspace version.' }

    await expect(caller.references({ workspaceId: randomUUID() })).rejects.toMatchObject(expected)
    await expect(
      caller.setEnabled({ workspaceId: randomUUID(), enabled: true }),
    ).rejects.toMatchObject(expected)
    await expect(
      caller.update({ workspaceId: randomUUID(), entries: [entry()] }),
    ).rejects.toMatchObject(expected)
    await expect(
      caller.clone({ workspaceId: randomUUID(), name: `nowhere-${fixtures.suffix}` }),
    ).rejects.toMatchObject(expected)
  })

  it('refuses to call a workspace with a run in flight archivable (FR-128)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const pinned = page.items.find((item) => item.name === `pinned-${fixtures.suffix}`)
    const alpha = page.items.find((item) => item.name === `alpha-${fixtures.suffix}`)

    const withRun = await asAdmin().references({ workspaceId: pinned?.id ?? '' })
    expect(withRun.activeWorkflowCount).toBe(1)
    expect(withRun.totalWorkflowCount).toBe(1)
    expect(withRun.archivable).toBe(false)

    const untouched = await asAdmin().references({ workspaceId: alpha?.id ?? '' })
    expect(untouched).toMatchObject({
      executionProfiles: [],
      integrations: [],
      activeWorkflowCount: 0,
      archivable: true,
    })
  })
})
