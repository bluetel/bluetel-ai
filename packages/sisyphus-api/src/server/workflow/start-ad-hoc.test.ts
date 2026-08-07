import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  computeLeases,
  executionProfiles,
  profileOverrides,
  scopedCredentials,
  workflowEntries,
  workflowEvents,
  workflows,
  workspaceEntries,
  workspaces,
  workspaceVersions,
} from '../../db'
import type { StartAdHocInput } from '../../schemas'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import { createCallerFactory } from '../procedures'

import { workflowRouter } from './router'
import { startAdHocWorkflow } from './start-ad-hoc'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl } from './test-support'

/**
 * `workflow.startAdHoc` (T064a).
 *
 * Two things are settled here and they are settled separately, because they fail in different
 * ways.
 *
 * 1. **Who may reach it.** An ad hoc launch behind no gate is an unnamed execution profile that
 *    nobody granted to anybody, so a non-admin who could reach this procedure would satisfy FR-180 by
 *    never naming a profile at all. The first suite therefore asserts the refusal **and the
 *    record of it**, without a database, because a refusal that reaches the database has already
 *    lost.
 * 2. **What it writes, and what it does not.** The same FR-035 boundary `start.test.ts` guards:
 *    a `queued` row and nothing else — no outbound call, no compute lease, no credential.
 */

const connectionString = readTestDatabaseUrl()

const WORKSPACE_VERSION_ID = '77777777-7777-7777-8777-777777777777'
const BUNDLE_VERSION_ID = '66666666-6666-7666-8666-666666666666'
const NON_ADMIN_ID = '55555555-5555-7555-8555-555555555555'

const adHocInput = (overrides: Partial<StartAdHocInput> = {}): StartAdHocInput => ({
  setupBundleVersionId: BUNDLE_VERSION_ID,
  workflowType: 'delegated',
  model: 'claude-opus-5',
  instanceType: 'm7i.large',
  purchaseMode: 'spot',
  prompt: 'Do the thing.',
  workspace: { source: 'workspace', workspaceVersionId: WORKSPACE_VERSION_ID },
  ...overrides,
})

/** A handle that fails loudly: a refused launch must not reach a query. */
const unreachableDatabase = new Proxy(
  {},
  {
    get: () => {
      throw new Error('an ad hoc launch by a non-admin must be refused before it reaches the data')
    },
  },
) as SisyphusDatabase

const callerFor = (
  role: 'admin' | 'engineer',
  recordDenial: (denial: AuthorisationDenial) => Promise<void>,
) => {
  const session: SisyphusSession = {
    user: {
      id: NON_ADMIN_ID,
      email: 'engineer@bluetel.co.uk',
      displayName: 'An Engineer',
      role,
      isActive: true,
    },
    expiresAt: new Date(Date.now() + 60_000),
  }

  const context: SisyphusContext = {
    headers: new Headers(),
    dependencies: {
      db: unreachableDatabase,
      resolveSession: () => Promise.resolve(session),
      resolveMachineCredential: () => Promise.resolve(null),
      recordDenial,
    },
    db: unreachableDatabase,
    session,
    scope: {
      resolve: () => Promise.reject(new Error('an ad hoc launch is gated by role, never by scope')),
    },
    machineCredential: () => Promise.resolve(null),
  }

  return createCallerFactory(workflowRouter)(context)
}

describe('startAdHoc is admin-only, and the attempt is recorded (FR-180, FR-187)', () => {
  it('refuses a signed-in non-admin with FORBIDDEN', async () => {
    const caller = callerFor('engineer', () => Promise.resolve())

    await expect(caller.startAdHoc(adHocInput())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This action requires the admin role.',
    })
  })

  it('records the attempt as a not_admin denial naming the caller and the path', async () => {
    const recorded: AuthorisationDenial[] = []
    const caller = callerFor('engineer', (denial) => {
      recorded.push(denial)
      return Promise.resolve()
    })

    await expect(caller.startAdHoc(adHocInput())).rejects.toThrow()

    expect(recorded).toStrictEqual([
      { reason: 'not_admin', userId: NON_ADMIN_ID, path: 'startAdHoc' },
    ])
  })

  it('refuses before the database is touched, so nothing is written and nothing is read', async () => {
    // The proxy handle throws on any property access. Reaching it would surface as that error
    // rather than as FORBIDDEN, which is what this asserts the absence of.
    const caller = callerFor('engineer', () => Promise.resolve())

    await expect(caller.startAdHoc(adHocInput())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses the workspace picker to a non-admin too, and records that as well', async () => {
    const recorded: AuthorisationDenial[] = []
    const caller = callerFor('engineer', (denial) => {
      recorded.push(denial)
      return Promise.resolve()
    })

    await expect(caller.adHocWorkspaces()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(recorded[0]?.reason).toBe('not_admin')
  })

  it('records nothing when the caller is an admin — only refusals are events', async () => {
    const recorded: AuthorisationDenial[] = []
    const caller = callerFor('admin', (denial) => {
      recorded.push(denial)
      return Promise.resolve()
    })

    // The admin gets past the gate and then hits the unreachable handle, which is the proof that
    // the gate let them through.
    await expect(caller.startAdHoc(adHocInput())).rejects.toThrow(/must be refused before/)
    expect(recorded).toStrictEqual([])
  })
})

describe.skipIf(connectionString === undefined)(
  'startAdHocWorkflow against a live database',
  () => {
    let fixture: TwoProfileFixture
    let db: SisyphusDatabase
    let ids: TwoProfileIds

    beforeAll(async () => {
      fixture = createTwoProfileFixture(connectionString ?? '')
      await fixture.open()
      db = fixture.db()
      ids = fixture.ids()
    }, 60_000)

    afterAll(async () => {
      await fixture.close()
    }, 30_000)

    afterEach(() => {
      vi.restoreAllMocks()
    })

    const launch = (overrides: Partial<StartAdHocInput> = {}) =>
      startAdHocWorkflow({
        db,
        actorUserId: ids.admin,
        input: adHocInput({
          setupBundleVersionId: ids.bundleVersion,
          workspace: { source: 'workspace', workspaceVersionId: ids.a.workspaceVersionId },
          ...overrides,
        }),
      })

    describe('what it writes', () => {
      it('creates a queued run owned and initiated by the admin who launched it', async () => {
        const started = await launch()

        expect(started.workflow.state).toBe('queued')
        expect(started.workflow.ownerUserId).toBe(ids.admin)
        expect(started.workflow.initiatedByUserId).toBe(ids.admin)
      })

      it('records that it was ad hoc by naming no profile at all (FR-126)', async () => {
        const started = await launch()

        expect(started.workflow.executionProfileId).toBeNull()
        expect(started.workflow.executionProfileVersionId).toBeNull()
      })

      it('carries the entered job spec onto the row, with no profile to fall back on', async () => {
        const started = await launch({
          instanceType: 'm7i.4xlarge',
          purchaseMode: 'on_demand',
          turnCap: 40,
          spendCap: '25.0000',
        })

        expect(started.workflow).toMatchObject({
          model: 'claude-opus-5',
          instanceType: 'm7i.4xlarge',
          purchaseMode: 'on_demand',
          turnCap: 40,
          spendCap: '25.0000',
        })
      })

      it('records the prompt as sent — there is no preamble above it (FR-065)', async () => {
        const started = await launch({ prompt: 'Fix the flaky test.' })

        expect(started.workflow.assembledPrompt).toBe('Fix the flaky test.')
      })

      it('assigns a session id before anything starts (FR-052)', async () => {
        expect((await launch()).workflow.sessionId).toMatch(/^[0-9a-f-]{36}$/)
      })

      it('copies the pinned workspace version’s entries onto the run (FR-114)', async () => {
        const started = await launch()
        const rows = await db
          .select()
          .from(workflowEntries)
          .where(eq(workflowEntries.workflowId, started.workflow.id))

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ repositoryUrl: ids.a.repositoryUrl, isPrimary: true })
      })

      it('writes one created event saying the run was ad hoc (FR-064, FR-126)', async () => {
        const started = await launch()
        const events = await db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.workflowId, started.workflow.id))

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ event: 'created', actorUserId: ids.admin })
        expect(events[0]?.detail).toMatchObject({ adHoc: true, savedAsExecutionProfileId: null })
      })

      it('writes no overrides — there was no profile to deviate from (FR-123)', async () => {
        const started = await launch()
        const rows = await db
          .select()
          .from(profileOverrides)
          .where(eq(profileOverrides.workflowId, started.workflow.id))

        expect(rows).toStrictEqual([])
      })

      it('answers with a queue position, so waiting is distinguishable from stuck (FR-040)', async () => {
        expect((await launch()).queuePosition).toBeGreaterThan(0)
      })
    })

    describe('what it does not do — the FR-035 boundary', () => {
      it('makes no outbound call of any kind', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch')

        await launch()

        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('takes no compute lease — admission is the control plane’s alone (FR-078)', async () => {
        const started = await launch()

        expect(
          await db
            .select()
            .from(computeLeases)
            .where(eq(computeLeases.workflowId, started.workflow.id)),
        ).toStrictEqual([])
      })

      it('mints no credential — that is the control plane’s alone (FR-037)', async () => {
        const started = await launch()

        expect(
          await db
            .select()
            .from(scopedCredentials)
            .where(eq(scopedCredentials.workflowId, started.workflow.id)),
        ).toStrictEqual([])
      })

      it('leaves the run in queued, never in provisioning', async () => {
        const started = await launch()
        const rows = await db.select().from(workflows).where(eq(workflows.id, started.workflow.id))

        expect(rows[0]?.state).toBe('queued')
      })
    })

    describe('a repository entered by hand (FR-129)', () => {
      it('materialises a workspace version so the run can say what it checked out (FR-125)', async () => {
        const started = await launch({
          workspace: {
            source: 'repository',
            repositoryUrl: 'git@github.com:org/one-off.git',
            baseBranch: 'develop',
          },
        })

        expect(started.materialisedWorkspace).toBe(true)

        const entries = await db
          .select()
          .from(workflowEntries)
          .where(eq(workflowEntries.workflowId, started.workflow.id))

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
          repositoryUrl: 'git@github.com:org/one-off.git',
          baseBranch: 'develop',
          subdirectory: 'one-off',
          isPrimary: true,
        })
      })

      it('creates that workspace disabled, so it is never offered again unvalidated (FR-124)', async () => {
        const started = await launch({
          workspace: {
            source: 'repository',
            repositoryUrl: 'git@github.com:org/second-one-off.git',
            baseBranch: 'main',
          },
        })

        const rows = await db
          .select({ enabled: workspaces.enabled, name: workspaces.name })
          .from(workspaces)
          .innerJoin(workspaceVersions, eq(workspaceVersions.workspaceId, workspaces.id))
          .where(eq(workspaceVersions.id, started.workflow.workspaceVersionId))

        expect(rows[0]?.enabled).toBe(false)
        expect(rows[0]?.name).toContain('ad hoc: second-one-off')
      })

      it('says so on the timeline, so a by-product workspace is explicable later', async () => {
        const started = await launch({
          workspace: {
            source: 'repository',
            repositoryUrl: 'git@github.com:org/third-one-off.git',
            baseBranch: 'main',
          },
        })

        const events = await db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.workflowId, started.workflow.id))

        expect(events[0]?.detail).toMatchObject({ materialisedWorkspace: true })
      })
    })

    describe('saving the configuration as a profile (FR-129)', () => {
      it('creates a profile carrying the entered spec, and leaves it disabled (FR-124)', async () => {
        const started = await launch({
          turnCap: 12,
          spendCap: '9.0000',
          saveAsProfile: { name: 'Saved from ad hoc one', description: 'From a launch.' },
        })

        expect(started.savedProfile?.name).toBe('Saved from ad hoc one')

        const profile = await db
          .select()
          .from(executionProfiles)
          .where(eq(executionProfiles.id, started.savedProfile?.executionProfileId ?? ''))

        expect(profile[0]).toMatchObject({ name: 'Saved from ad hoc one', enabled: false })
        expect(profile[0]?.currentVersionId).toBe(started.savedProfile?.executionProfileVersionId)
      })

      it('leaves the run itself ad hoc — saving a profile is not launching from one (FR-126)', async () => {
        const started = await launch({ saveAsProfile: { name: 'Saved from ad hoc two' } })

        expect(started.workflow.executionProfileId).toBeNull()
        expect(started.workflow.executionProfileVersionId).toBeNull()
      })

      it('links the two on the timeline, which is the only place the link lives', async () => {
        const started = await launch({ saveAsProfile: { name: 'Saved from ad hoc three' } })
        const events = await db
          .select()
          .from(workflowEvents)
          .where(eq(workflowEvents.workflowId, started.workflow.id))

        expect(events[0]?.detail).toMatchObject({
          savedAsExecutionProfileId: started.savedProfile?.executionProfileId,
        })
      })

      it('refuses a taken name and starts nothing, so the configuration is not lost', async () => {
        await launch({ saveAsProfile: { name: 'Saved from ad hoc four' } })

        const before = await db.select().from(workflows)
        await expect(
          launch({ saveAsProfile: { name: 'Saved from ad hoc four' } }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })

        expect(await db.select().from(workflows)).toHaveLength(before.length)
      })

      it('does not save one when it was not asked to', async () => {
        expect((await launch()).savedProfile).toBeUndefined()
      })
    })

    describe('what it refuses', () => {
      it('refuses a workspace version that does not exist', async () => {
        await expect(
          launch({ workspace: { source: 'workspace', workspaceVersionId: WORKSPACE_VERSION_ID } }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('refuses a setup bundle version that does not exist', async () => {
        await expect(launch({ setupBundleVersionId: BUNDLE_VERSION_ID })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
      })

      it('refuses an autonomous run with no caps, before writing anything (FR-055)', async () => {
        const before = await db.select().from(workflows)

        await expect(launch({ workflowType: 'autonomous' })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        })
        expect(await db.select().from(workflows)).toHaveLength(before.length)
      })

      it('refuses an owner who is not an active user (FR-132, FR-176)', async () => {
        await expect(launch({ ownerUserId: NON_ADMIN_ID })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        })
      })

      it('accepts an owner who is, and records them as owner with the admin as initiator', async () => {
        const started = await launch({ ownerUserId: ids.alice })

        expect(started.workflow.ownerUserId).toBe(ids.alice)
        expect(started.workflow.initiatedByUserId).toBe(ids.admin)
      })

      it('leaves no orphan workspace behind when the launch is refused', async () => {
        const before = await db.select().from(workspaceEntries)

        await expect(
          launch({
            workflowType: 'autonomous',
            workspace: {
              source: 'repository',
              repositoryUrl: 'git@github.com:org/never-launched.git',
              baseBranch: 'main',
            },
          }),
        ).rejects.toThrow()

        expect(await db.select().from(workspaceEntries)).toHaveLength(before.length)
      })
    })
  },
)
