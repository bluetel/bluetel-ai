import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { configurationAudit, setupBundleVersions, validationRuns } from '../../db'
import type { UserRole } from '../../enums'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import { bundleNotFoundError, bundlesRouter } from './bundles'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

const createCaller = createCallerFactory(bundlesRouter)

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
    validationCredential: () => Promise.resolve(null),
  }
}

describe('the admin.bundles contract', () => {
  it('exposes exactly the procedures api-surface.md names', () => {
    expect(Object.keys(bundlesRouter._def.procedures).sort()).toStrictEqual([
      'list',
      'references',
      'register',
      'replaceArchive',
      'setEnabled',
      'updateMetadata',
      'validate',
      'validationRuns',
    ])
  })

  it('makes `list` a query and every write a mutation', () => {
    const procedures = bundlesRouter._def.procedures
    expect(procedures.list._def.type).toBe('query')
    expect(procedures.register._def.type).toBe('mutation')
    expect(procedures.replaceArchive._def.type).toBe('mutation')
    expect(procedures.setEnabled._def.type).toBe('mutation')
    expect(procedures.validate._def.type).toBe('mutation')
  })
})

describe('bundleNotFoundError', () => {
  it('is NOT_FOUND, never FORBIDDEN — FORBIDDEN would confirm the id exists (FR-190)', () => {
    expect(bundleNotFoundError().code).toBe('NOT_FOUND')
  })

  it('does not say whether it was the bundle or the version that was missing', () => {
    expect(bundleNotFoundError().message).toBe('No such setup bundle or bundle version.')
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

/**
 * The router against a real Postgres, on a private scratch database. Skipped — not failed —
 * without `SISYPHUS_TEST_DATABASE_URL`, so a plain `vitest run` stays green.
 */
describe.skipIf(liveDatabaseUrl === undefined)('admin.bundles against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
  const denials: AuthorisationDenial[] = []

  let admin: CallerIdentity
  let engineer: CallerIdentity

  const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials))
  const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials))

  /** A digest is 64 lower-case hex characters; the schema refuses anything else. */
  const digest = (seed: string): string =>
    seed
      .repeat(64)
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, '0')

  const auditFor = async (bundleId: string) =>
    fixtures
      .db()
      .select()
      .from(configurationAudit)
      .where(
        and(
          eq(configurationAudit.entityType, 'setup_bundle'),
          eq(configurationAudit.entityId, bundleId),
        ),
      )

  beforeAll(async () => {
    await fixtures.open()
    const seededAdmin = await fixtures.seedUser({ label: 'bundle-admin', role: 'admin' })
    const seededEngineer = await fixtures.seedUser({ label: 'bundle-engineer' })
    admin = { ...seededAdmin, role: 'admin' }
    engineer = { ...seededEngineer, role: 'engineer' }
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  it('refuses every mutation to a non-admin and records the denial (FR-167, FR-169)', async () => {
    denials.length = 0
    const caller = asEngineer()

    await expect(
      caller.register({
        name: `refused-${fixtures.suffix}`,
        spendCapsEnforceable: false,
        s3Key: 'bundles/refused.tar.gz',
        contentDigest: digest('a'),
        sizeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      caller.setEnabled({ setupBundleId: randomUUID(), enabled: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(caller.references({ setupBundleId: randomUUID() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    expect(denials.map((denial) => denial.reason)).toStrictEqual([
      'not_admin',
      'not_admin',
      'not_admin',
    ])
  })

  it('registers a bundle disabled, at version 1, with the acting admin on the trail (FR-085, FR-178)', async () => {
    const registered = await asAdmin().register({
      name: `alpha-${fixtures.suffix}`,
      description: 'The first bundle.',
      spendCapsEnforceable: true,
      s3Key: `bundles/alpha-${fixtures.suffix}/1.tar.gz`,
      contentDigest: digest('a'),
      sizeBytes: 2048,
    })

    expect(registered.version.version).toBe(1)
    expect(registered.bundle.enabled).toBe(false)
    expect(registered.bundle.spendCapsEnforceable).toBe(true)
    expect(registered.version.registeredByUserId).toBe(admin.id)

    const entries = await auditFor(registered.bundle.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'registered',
      actorUserId: admin.id,
      entityVersion: 1,
    })
    expect(entries[0]?.detail).toMatchObject({ contentDigest: digest('a'), sizeBytes: 2048 })
  })

  it('refuses a duplicate name rather than silently versioning someone else’s bundle', async () => {
    await expect(
      asAdmin().register({
        name: `alpha-${fixtures.suffix}`,
        spendCapsEnforceable: false,
        s3Key: 'bundles/clash.tar.gz',
        contentDigest: digest('b'),
        sizeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('creates a version on replacement and leaves the first archive intact (FR-090)', async () => {
    const first = await asAdmin().register({
      name: `beta-${fixtures.suffix}`,
      spendCapsEnforceable: false,
      s3Key: `bundles/beta-${fixtures.suffix}/first.tar.gz`,
      contentDigest: digest('c'),
      sizeBytes: 100,
    })

    const second = await asAdmin().replaceArchive({
      setupBundleId: first.bundle.id,
      s3Key: `bundles/beta-${fixtures.suffix}/second.tar.gz`,
      contentDigest: digest('d'),
      sizeBytes: 200,
    })

    expect(second.version.version).toBe(2)
    expect(second.version.id).not.toBe(first.version.id)

    // The whole of FR-090: replacement is an insert, so both rows exist and the first archive's
    // key and digest are byte-for-byte what they were. An implementation that overwrote the
    // archive in place would leave one row here, and a workflow that pinned version 1 would
    // silently start unpacking version 2's contents.
    const versions = await fixtures
      .db()
      .select()
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.setupBundleId, first.bundle.id))
      .orderBy(setupBundleVersions.version)

    expect(versions.map((version) => version.version)).toStrictEqual([1, 2])
    expect(versions[0]?.s3Key).toBe(`bundles/beta-${fixtures.suffix}/first.tar.gz`)
    expect(versions[0]?.contentDigest).toBe(digest('c'))
    expect(versions[0]?.sizeBytes).toBe(100)
    expect(versions[1]?.s3Key).not.toBe(versions[0]?.s3Key)

    const entries = await auditFor(first.bundle.id)
    expect(entries.map((entry) => entry.action).sort()).toStrictEqual(['registered', 'replaced'])
    expect(entries.find((entry) => entry.action === 'replaced')).toMatchObject({ entityVersion: 2 })
  })

  it('records enable and disable, and writes nothing for a no-op (FR-168, FR-178)', async () => {
    const registered = await asAdmin().register({
      name: `gamma-${fixtures.suffix}`,
      spendCapsEnforceable: false,
      s3Key: `bundles/gamma-${fixtures.suffix}/1.tar.gz`,
      contentDigest: digest('e'),
      sizeBytes: 10,
    })
    const bundleId = registered.bundle.id

    const enabled = await asAdmin().setEnabled({ setupBundleId: bundleId, enabled: true })
    expect(enabled.enabled).toBe(true)

    // Already enabled: the row comes back, the trail does not grow.
    await asAdmin().setEnabled({ setupBundleId: bundleId, enabled: true })

    const disabled = await asAdmin().setEnabled({ setupBundleId: bundleId, enabled: false })
    expect(disabled.enabled).toBe(false)

    const actions = (await auditFor(bundleId)).map((entry) => entry.action).sort()
    expect(actions).toStrictEqual(['disabled', 'enabled', 'registered'])
  })

  it('edits metadata without touching the archive (FR-093)', async () => {
    const registered = await asAdmin().register({
      name: `delta-${fixtures.suffix}`,
      spendCapsEnforceable: false,
      s3Key: `bundles/delta-${fixtures.suffix}/1.tar.gz`,
      contentDigest: digest('f'),
      sizeBytes: 10,
    })

    const updated = await asAdmin().updateMetadata({
      setupBundleId: registered.bundle.id,
      description: 'Flat-rate seat credential.',
      spendCapsEnforceable: true,
    })

    expect(updated.description).toBe('Flat-rate seat credential.')
    expect(updated.spendCapsEnforceable).toBe(true)

    const versions = await fixtures
      .db()
      .select()
      .from(setupBundleVersions)
      .where(eq(setupBundleVersions.setupBundleId, registered.bundle.id))
    expect(versions).toHaveLength(1)
    expect(versions[0]?.contentDigest).toBe(digest('f'))
  })

  it('reports an unknown bundle and an unknown version identically (FR-190)', async () => {
    const caller = asAdmin()
    const expected = { code: 'NOT_FOUND', message: 'No such setup bundle or bundle version.' }

    await expect(caller.references({ setupBundleId: randomUUID() })).rejects.toMatchObject(expected)
    await expect(
      caller.setEnabled({ setupBundleId: randomUUID(), enabled: true }),
    ).rejects.toMatchObject(expected)
    await expect(
      caller.replaceArchive({
        setupBundleId: randomUUID(),
        s3Key: 'bundles/nowhere.tar.gz',
        contentDigest: digest('a'),
        sizeBytes: 1,
      }),
    ).rejects.toMatchObject(expected)
    await expect(caller.validate({ setupBundleVersionId: randomUUID() })).rejects.toMatchObject(
      expected,
    )
    await expect(caller.validationRuns({ setupBundleId: randomUUID() })).rejects.toMatchObject(
      expected,
    )
  })

  it('shows an admin every bundle, including the disabled ones', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })

    expect(page.items.length).toBeGreaterThan(1)
    expect(page.items.some((bundle) => !bundle.enabled)).toBe(true)
  })

  it('shows a non-admin only the enabled list, whatever they asked for (FR-086)', async () => {
    // The bundle a non-admin is allowed to see, and the wider set they are not.
    const visible = await asAdmin().register({
      name: `epsilon-${fixtures.suffix}`,
      spendCapsEnforceable: false,
      s3Key: `bundles/epsilon-${fixtures.suffix}/1.tar.gz`,
      contentDigest: digest('1'),
      sizeBytes: 10,
    })
    await asAdmin().setEnabled({ setupBundleId: visible.bundle.id, enabled: true })

    // `enabledOnly: false` is the request an enumeration attempt would make. It is narrowed, not
    // refused: refusing would itself confirm that a wider list exists.
    const page = await asEngineer().list({
      enabledOnly: false,
      includeArchived: true,
      limit: 50,
    })

    expect(page.items.map((bundle) => bundle.id)).toStrictEqual([visible.bundle.id])
    expect(page.items.every((bundle) => bundle.enabled)).toBe(true)
  })

  it('never puts the archive’s storage key on the list a non-admin can read (FR-084)', async () => {
    const page = await asEngineer().list({ enabledOnly: true, includeArchived: false, limit: 50 })
    const [bundle] = page.items

    expect(bundle).toBeDefined()
    expect(JSON.stringify(bundle)).not.toContain('bundles/epsilon')
    expect(bundle.latestVersion?.contentDigest).toBe(digest('1'))
  })

  it('says a bundle has never been validated rather than inventing a result (FR-148)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((bundle) => bundle.name === `alpha-${fixtures.suffix}`)

    expect(alpha).toBeDefined()
    expect(alpha?.latestValidation).toBeUndefined()
  })

  it('opens a validation run with no verdict, and surfaces it as the latest (FR-147, FR-148)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((bundle) => bundle.name === `alpha-${fixtures.suffix}`)
    const versionId = alpha?.latestVersion?.id
    expect(versionId).toBeDefined()

    const run = await asAdmin().validate({ setupBundleVersionId: versionId ?? '' })

    // The row records that a validation was asked for. The verdict is the control plane's to write.
    expect(run.outcome).toBeNull()
    expect(run.endedAt).toBeNull()
    expect(run.triggeredByUserId).toBe(admin.id)

    const history = await asAdmin().validationRuns({ setupBundleId: alpha?.id ?? '' })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ id: run.id, version: 1, outcome: null })

    const after = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alphaAfter = after.items.find((bundle) => bundle.id === alpha?.id)
    expect(alphaAfter?.latestValidation).toMatchObject({ id: run.id, outcome: null, version: 1 })
  })

  it('surfaces the most recent validation, not the most recent pass', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((bundle) => bundle.name === `alpha-${fixtures.suffix}`)
    const versionId = alpha?.latestVersion?.id ?? ''

    const first = await asAdmin().validate({ setupBundleVersionId: versionId })
    await fixtures
      .db()
      .update(validationRuns)
      .set({ outcome: 'passed', endedAt: new Date() })
      .where(eq(validationRuns.id, first.id))

    const second = await asAdmin().validate({ setupBundleVersionId: versionId })
    await fixtures
      .db()
      .update(validationRuns)
      .set({ outcome: 'failed', endedAt: new Date() })
      .where(eq(validationRuns.id, second.id))

    const after = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alphaAfter = after.items.find((bundle) => bundle.id === alpha?.id)

    // A bundle that passed once and fails now reports the failure. Reporting the pass would be the
    // exact confusion contracts/setup-bundle.md says both results are recorded to avoid.
    expect(alphaAfter?.latestValidation?.outcome).toBe('failed')
  })

  it('reports a bundle nothing references as archivable (FR-092)', async () => {
    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const alpha = page.items.find((bundle) => bundle.name === `alpha-${fixtures.suffix}`)

    const references = await asAdmin().references({ setupBundleId: alpha?.id ?? '' })

    expect(references).toMatchObject({
      executionProfiles: [],
      integrations: [],
      activeWorkflowCount: 0,
      archivable: true,
    })
  })

  it('refuses to call a bundle with a run in flight archivable (FR-092)', async () => {
    // `seedWorkflow` builds its own bundle and workspace; that bundle is the one under test here.
    const ownerId = admin.id
    await fixtures.seedWorkflow({ ownerUserId: ownerId, state: 'running' })

    const page = await asAdmin().list({ enabledOnly: false, includeArchived: false, limit: 50 })
    const fixtureBundle = page.items.find((bundle) =>
      bundle.name.startsWith(`fixture-bundle-${fixtures.suffix}`),
    )
    expect(fixtureBundle).toBeDefined()

    const references = await asAdmin().references({ setupBundleId: fixtureBundle?.id ?? '' })
    expect(references.activeWorkflowCount).toBe(1)
    expect(references.totalWorkflowCount).toBe(1)
    expect(references.archivable).toBe(false)
  })
})
