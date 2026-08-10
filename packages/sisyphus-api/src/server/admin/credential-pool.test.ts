import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  agentCredentials,
  credentialGroups,
  credentialLeases,
  executionProfiles,
  profileCredentialGroups,
  workflows,
} from '../../db'
import type { UserRole } from '../../enums'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import type { WorkflowEventEmitter } from '../notify'
import { createRecordingEmitter } from '../notify/test-support'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import {
  assemblePool,
  credentialPoolRouter,
  GROUP_UNDERSIZED,
  healthOf,
  holderKindOf,
  POOL_HEALTHY,
  POOL_UNDERSIZED,
  pressureOf,
  verdictOf,
} from './credential-pool'
import type { CredentialPoolRow } from './credential-store'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * The contract test for `admin.credentialPool` (T106, FR-053, FR-054, FR-055, FR-074, FR-079,
 * SC-011).
 *
 * Written against the interface spec.md and data-model.md already fix, before the router existed.
 * Five things are load-bearing here and everything else is bookkeeping around them:
 *
 * 1. **Every state is distinguishable, and the seats are grouped by credential group** (FR-053).
 *    Not "the view returns rows": the point of the screen is that `available`, `held`,
 *    `cooling_off`, `unhealthy` and `awaiting_login` are five different situations with five
 *    different remedies, and a view that reduced them to usable/unusable would answer none of them.
 * 2. **Holders are broken down `running` / `paused` / `parked`, plus `keep_alive`** (FR-074). This
 *    is the assertion the requirement actually exists for: a pool full of parked holders looks
 *    exactly like an idle pool from any summary that counts only "in use", and a keep-alive looks
 *    exactly like a stuck seat unless it is named.
 * 3. **Queue depth and longest wait are per group** (FR-054, SC-011), derived from `workflows` in
 *    `awaiting_credential` with **no queue table** — so the fixtures write workflow rows and never a
 *    queue row, and the view is asked to find them.
 * 4. **Spend is attributable per credential** (FR-055), by the join through
 *    `workflows.agent_credential_id`. The fixture charges two runs to one seat and none to another,
 *    which is the case a second ledger would eventually get wrong.
 * 5. **A non-administrator is refused entirely, reads included** (FR-053, data-model.md → Access
 *    scoping), and **nothing here notifies anyone** (FR-079).
 *
 * The pure folds are tested without a database, because "a parked holder is counted as parked"
 * should not require Postgres to be running to be true. The queries are tested against a real one,
 * because the queue derivation and the spend aggregate are SQL and nothing else.
 */

/** One seat row, with everything free unless the test says otherwise. */
const poolRow = (overrides: Partial<CredentialPoolRow> = {}): CredentialPoolRow => ({
  id: randomUUID(),
  credentialGroupId: 'group-1',
  credentialGroupName: 'alpha',
  credentialGroupEnabled: true,
  name: 'seat',
  state: 'available',
  enabled: true,
  selectable: true,
  hasSecret: true,
  heldBy: null,
  lastUsedAt: null,
  lastExercisedAt: null,
  lastLoginAt: null,
  coolingOffUntil: null,
  lastFailureReason: null,
  archivedAt: null,
  holderWorkflowId: null,
  holderWorkflowState: null,
  holderAcquiredAt: null,
  ...overrides,
})

describe('the admin.credentialPool contract', () => {
  it('exposes exactly the one procedure SC-011 asks for, and no more', () => {
    // One view, deliberately. Four procedures would render capacity, holders, the queue and spend
    // at four different instants, and the comparison an administrator is making is between two of
    // those numbers.
    expect(Object.keys(credentialPoolRouter._def.procedures)).toStrictEqual(['view'])
  })

  it('makes it a query — a screen that reported the pool by changing it would be a different thing', () => {
    expect(credentialPoolRouter._def.procedures.view._def.type).toBe('query')
  })
})

/**
 * FR-074, as a pure function over one row. **The requirement is the distinctions, not the count.**
 */
describe('holderKindOf', () => {
  it('reports nothing holding a free seat', () => {
    expect(holderKindOf(poolRow())).toBeUndefined()
  })

  it('distinguishes running, paused and parked holders (FR-074)', () => {
    expect(
      holderKindOf(
        poolRow({
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w',
          holderWorkflowState: 'running',
        }),
      ),
    ).toBe('running')
    expect(
      holderKindOf(
        poolRow({
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w',
          holderWorkflowState: 'paused',
        }),
      ),
    ).toBe('paused')
    expect(
      holderKindOf(
        poolRow({
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w',
          holderWorkflowState: 'parked_resumable',
        }),
      ),
    ).toBe('parked')
  })

  it('names a keep-alive as a keep-alive, so it is not read as a stuck seat (FR-035, FR-038)', () => {
    // A keep-alive takes no lease — it has no workflow to take one for — so its only evidence is
    // `held_by`. Read the lease join first and it becomes an unexplained `held` with nothing
    // attached, which is exactly what a parked holder looks like from a distance.
    expect(holderKindOf(poolRow({ state: 'held', heldBy: 'keep_alive' }))).toBe('keep_alive')
  })

  it('does not report a held seat as free when the claim is unresolved', () => {
    // A seat in `held` with neither a lease nor a keep-alive claim is a defect somewhere else.
    // Reporting it as free would hide the one row an administrator needs to see.
    expect(holderKindOf(poolRow({ state: 'held', heldBy: 'workflow' }))).toBe('other')
  })

  it('counts a provisioning holder rather than dropping it, so the breakdown adds up', () => {
    expect(
      holderKindOf(
        poolRow({
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w',
          holderWorkflowState: 'provisioning',
        }),
      ),
    ).toBe('other')
  })
})

/** FR-075's distinction, which is the one an alert would otherwise get wrong. */
describe('healthOf', () => {
  it('keeps broken and rate-limited apart (FR-075)', () => {
    expect(healthOf(poolRow({ state: 'unhealthy', selectable: false }))).toBe('unhealthy')
    expect(healthOf(poolRow({ state: 'cooling_off', selectable: false }))).toBe('cooling_off')
  })

  it('reports a healthy seat that is merely busy as healthy, not as a problem', () => {
    expect(healthOf(poolRow({ state: 'held', heldBy: 'workflow', selectable: false }))).toBe(
      'healthy',
    )
  })

  it('reports a withdrawn seat as withdrawn, whether the switch was on the seat or its group', () => {
    expect(healthOf(poolRow({ enabled: false, selectable: false }))).toBe('withdrawn')
    expect(healthOf(poolRow({ credentialGroupEnabled: false, selectable: false }))).toBe(
      'withdrawn',
    )
    expect(healthOf(poolRow({ archivedAt: new Date(), selectable: false }))).toBe('withdrawn')
  })

  it('reports a registered seat with no login as never logged in (FR-008)', () => {
    expect(
      healthOf(poolRow({ state: 'awaiting_login', hasSecret: false, selectable: false })),
    ).toBe('never_logged_in')
  })
})

/**
 * SC-011's whole content: an under-sized **group** is distinguishable from an under-sized **pool**.
 */
describe('pressureOf and verdictOf', () => {
  it('calls a full group with nothing waiting `full`, not under-sized', () => {
    // A pool with no free seats and no queue is correctly sized and fully utilised, which is what a
    // pool is for. Flagging it would train an administrator to buy capacity for a working pool.
    expect(pressureOf({ selectableCount: 0, queueDepth: 0 })).toBe('full')
    expect(pressureOf({ selectableCount: 2, queueDepth: 0 })).toBe('available')
    expect(pressureOf({ selectableCount: 0, queueDepth: 3 })).toBe('starved')
  })

  it('says nothing is under-sized while nothing is waiting', () => {
    expect(verdictOf({ queueDepth: 0, selectableCount: 0 })).toBe(POOL_HEALTHY)
  })

  it('calls it an under-sized pool only when no group anywhere has a free seat', () => {
    expect(verdictOf({ queueDepth: 1, selectableCount: 0 })).toBe(POOL_UNDERSIZED)
  })

  it('calls it an under-sized group when capacity exists that these runs may not draw on (FR-063)', () => {
    // The common case, and the one an aggregate number hides: the platform has free seats, and the
    // waiting runs are not attached to the group holding them. More platform-wide capacity would
    // not clear this queue.
    expect(verdictOf({ queueDepth: 1, selectableCount: 4 })).toBe(GROUP_UNDERSIZED)
  })
})

describe('assemblePool', () => {
  const now = new Date('2026-03-01T12:00:00.000Z')

  it('lists a group that holds no credential at all — the most under-sized case there is', () => {
    // It contributes no credential row, so a view assembled outward from seats would omit exactly
    // the group most in need of buying for.
    const view = assemblePool({
      groups: [{ id: 'g-empty', name: 'empty', enabled: true }],
      rows: [],
      queueRows: [
        { credentialGroupId: 'g-empty', depth: 2, waitingSince: new Date(now.getTime() - 60_000) },
      ],
      queueTotals: {
        depth: 2,
        waitingSince: new Date(now.getTime() - 60_000),
        unattributableDepth: 0,
      },
      consumption: [],
      now,
    })

    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]).toMatchObject({
      credentialGroupName: 'empty',
      seatCount: 0,
      selectableCount: 0,
      pressure: 'starved',
    })
    expect(view.groups[0]?.queue).toMatchObject({ depth: 2, longestWaitMs: 60_000 })
    expect(view.verdict).toBe(POOL_UNDERSIZED)
    expect(view.starvedGroupNames).toStrictEqual(['empty'])
  })

  it('reports the platform queue once per run, never as the sum of the per-group depths', () => {
    // A run whose profile attaches to two groups is waiting on both, so it appears in both depths.
    // Adding them would report two runs waiting where there is one, which is a purchase order for a
    // seat nobody needed.
    const view = assemblePool({
      groups: [
        { id: 'g-1', name: 'alpha', enabled: true },
        { id: 'g-2', name: 'beta', enabled: true },
      ],
      rows: [],
      queueRows: [
        { credentialGroupId: 'g-1', depth: 1, waitingSince: now },
        { credentialGroupId: 'g-2', depth: 1, waitingSince: now },
      ],
      queueTotals: { depth: 1, waitingSince: now, unattributableDepth: 0 },
      consumption: [],
      now,
    })

    expect(view.groups.map((group) => group.queue.depth)).toStrictEqual([1, 1])
    expect(view.queue.depth).toBe(1)
  })

  it('keeps a wait that no group can clear out of every group’s depth (FR-126, FR-063)', () => {
    const view = assemblePool({
      groups: [{ id: 'g-1', name: 'alpha', enabled: true }],
      rows: [poolRow({ credentialGroupId: 'g-1' })],
      queueRows: [],
      queueTotals: { depth: 1, waitingSince: now, unattributableDepth: 1 },
      consumption: [],
      now,
    })

    expect(view.groups[0]?.queue.depth).toBe(0)
    expect(view.queue.unattributableDepth).toBe(1)
  })

  it('breaks holders down and totals them to the number of live claims (FR-074)', () => {
    const view = assemblePool({
      groups: [{ id: 'g-1', name: 'alpha', enabled: true }],
      rows: [
        poolRow({
          credentialGroupId: 'g-1',
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w1',
          holderWorkflowState: 'running',
          selectable: false,
        }),
        poolRow({
          credentialGroupId: 'g-1',
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w2',
          holderWorkflowState: 'paused',
          selectable: false,
        }),
        poolRow({
          credentialGroupId: 'g-1',
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w3',
          holderWorkflowState: 'parked_resumable',
          selectable: false,
        }),
        poolRow({
          credentialGroupId: 'g-1',
          state: 'held',
          heldBy: 'keep_alive',
          selectable: false,
        }),
        poolRow({ credentialGroupId: 'g-1' }),
      ],
      queueRows: [],
      queueTotals: { depth: 0, waitingSince: null, unattributableDepth: 0 },
      consumption: [],
      now,
    })

    expect(view.holders).toStrictEqual({
      running: 1,
      paused: 1,
      parked: 1,
      keepAlive: 1,
      other: 0,
      total: 4,
    })
    expect(view.seatCount).toBe(5)
    expect(view.selectableCount).toBe(1)
  })

  it('measures every hold and every wait against one clock', () => {
    const view = assemblePool({
      groups: [{ id: 'g-1', name: 'alpha', enabled: true }],
      rows: [
        poolRow({
          credentialGroupId: 'g-1',
          state: 'held',
          heldBy: 'workflow',
          holderWorkflowId: 'w1',
          holderWorkflowState: 'parked_resumable',
          holderAcquiredAt: new Date(now.getTime() - 3_600_000),
          selectable: false,
        }),
      ],
      queueRows: [],
      queueTotals: { depth: 0, waitingSince: null, unattributableDepth: 0 },
      consumption: [],
      now,
    })

    expect(view.observedAt).toBe(now)
    expect(view.groups[0]?.seats[0]?.holder?.heldForMs).toBe(3_600_000)
  })

  it('reports a seat that has never been used as having consumed nothing (FR-055)', () => {
    const view = assemblePool({
      groups: [{ id: 'g-1', name: 'alpha', enabled: true }],
      rows: [poolRow({ credentialGroupId: 'g-1', id: 'seat-1' })],
      queueRows: [],
      queueTotals: { depth: 0, waitingSince: null, unattributableDepth: 0 },
      consumption: [],
      now,
    })

    expect(view.groups[0]?.seats[0]?.consumption).toStrictEqual({
      workflowCount: 0,
      turnsUsed: 0,
      spendUsed: '0.0000',
      computeCostBasis: '0.0000',
    })
  })
})

/**
 * The refusal a call produced.
 *
 * Used instead of `expect.stringContaining` inside `toMatchObject`, which is typed `any` and so
 * turns a message assertion into an unchecked one.
 */
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
  notifier: WorkflowEventEmitter,
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
      notifier,
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

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)(
  'admin.credentialPool against a live database',
  () => {
    const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
    const denials: AuthorisationDenial[] = []
    /**
     * Wired so FR-079 is asserted against a notifier that **would** record a call, rather than
     * against the absence of one. An emitter left `undefined` proves nothing: the port is optional
     * and an unwired deployment is silent by construction.
     */
    const notifier = createRecordingEmitter()

    let admin: CallerIdentity
    let engineer: CallerIdentity

    const createCaller = createCallerFactory(credentialPoolRouter)
    const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials, notifier))
    const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials, notifier))

    const named = (label: string) => `${label}-${fixtures.suffix}`

    const seedGroup = async (label: string): Promise<string> => {
      const [group] = await fixtures
        .db()
        .insert(credentialGroups)
        .values({ name: named(label), createdByUserId: admin.id })
        .returning({ id: credentialGroups.id })
      return group.id
    }

    const seedCredential = async (input: {
      readonly label: string
      readonly credentialGroupId: string
      readonly state: 'awaiting_login' | 'available' | 'held' | 'cooling_off' | 'unhealthy'
      readonly heldBy?: string
      readonly coolingOffUntil?: Date
      readonly lastFailureReason?: string
      readonly lastExercisedAt?: Date
    }): Promise<string> => {
      const [credential] = await fixtures
        .db()
        .insert(agentCredentials)
        .values({
          credentialGroupId: input.credentialGroupId,
          name: named(input.label),
          state: input.state,
          // Every state past registration has had a login captured; `awaiting_login` has not, and
          // that null is what FR-008 turns into "unselectable by every path at once".
          secretId:
            input.state === 'awaiting_login' ? null : `sisyphus/agent/${named(input.label)}`,
          heldBy: input.heldBy ?? null,
          coolingOffUntil: input.coolingOffUntil ?? null,
          lastFailureReason: input.lastFailureReason ?? null,
          lastExercisedAt: input.lastExercisedAt ?? null,
          createdByUserId: admin.id,
        })
        .returning({ id: agentCredentials.id })
      return credential.id
    }

    const seedProfile = async (label: string): Promise<string> => {
      const [profile] = await fixtures
        .db()
        .insert(executionProfiles)
        .values({ name: named(label) })
        .returning({ id: executionProfiles.id })
      return profile.id
    }

    const attach = async (
      executionProfileId: string,
      credentialGroupId: string,
      position: number,
    ) => {
      await fixtures
        .db()
        .insert(profileCredentialGroups)
        .values({ executionProfileId, credentialGroupId, position })
    }

    /** A run in some state, optionally holding a seat and optionally waiting on a profile's groups. */
    const seedRun = async (input: {
      readonly state:
        | 'running'
        | 'paused'
        | 'parked_resumable'
        | 'awaiting_credential'
        | 'succeeded'
      readonly executionProfileId?: string
      readonly agentCredentialId?: string
      readonly holdsLease?: boolean
      readonly acquiredAt?: Date
      readonly createdAt?: Date
      readonly turnsUsed?: number
      readonly spendUsed?: string
      readonly computeCostBasis?: string
    }): Promise<string> => {
      const workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: input.state })

      await fixtures
        .db()
        .update(workflows)
        .set({
          executionProfileId: input.executionProfileId ?? null,
          agentCredentialId: input.agentCredentialId ?? null,
          ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
          ...(input.turnsUsed === undefined ? {} : { turnsUsed: input.turnsUsed }),
          ...(input.spendUsed === undefined ? {} : { spendUsed: input.spendUsed }),
          ...(input.computeCostBasis === undefined
            ? {}
            : { computeCostBasis: input.computeCostBasis }),
        })
        .where(eq(workflows.id, workflowId))

      if (input.holdsLease === true && input.agentCredentialId !== undefined) {
        await fixtures
          .db()
          .insert(credentialLeases)
          .values({
            agentCredentialId: input.agentCredentialId,
            workflowId,
            fence: 1,
            acquiredAt: input.acquiredAt ?? new Date(),
          })
      }

      return workflowId
    }

    /** The seeded world, named so the assertions read as sentences rather than as indices. */
    const world: {
      alphaId: string
      betaId: string
      emptyId: string
      freeSeatId: string
      runningSeatId: string
      pausedSeatId: string
      parkedSeatId: string
      keepAliveSeatId: string
      unhealthySeatId: string
      coolingSeatId: string
      registeredSeatId: string
      betaSeatId: string
      parkedWorkflowId: string
    } = {
      alphaId: '',
      betaId: '',
      emptyId: '',
      freeSeatId: '',
      runningSeatId: '',
      pausedSeatId: '',
      parkedSeatId: '',
      keepAliveSeatId: '',
      unhealthySeatId: '',
      coolingSeatId: '',
      registeredSeatId: '',
      betaSeatId: '',
      parkedWorkflowId: '',
    }

    beforeAll(async () => {
      await fixtures.open()
      const seededAdmin = await fixtures.seedUser({ label: 'pool-admin', role: 'admin' })
      const seededEngineer = await fixtures.seedUser({ label: 'pool-engineer' })
      admin = { ...seededAdmin, role: 'admin' }
      engineer = { ...seededEngineer, role: 'engineer' }

      // Three groups, named so they sort `alpha`, `beta`, `vacant`: `vacant` holds no seat at all and
      // has runs waiting on it, which is the case a seats-outward view would omit entirely.
      world.alphaId = await seedGroup('alpha')
      world.betaId = await seedGroup('beta')
      world.emptyId = await seedGroup('vacant')

      // Every credential state, in one group, so "distinguishable" is asserted rather than assumed.
      world.freeSeatId = await seedCredential({
        label: 'a-free',
        credentialGroupId: world.alphaId,
        state: 'available',
      })
      world.runningSeatId = await seedCredential({
        label: 'b-running',
        credentialGroupId: world.alphaId,
        state: 'held',
        heldBy: 'workflow',
      })
      world.pausedSeatId = await seedCredential({
        label: 'c-paused',
        credentialGroupId: world.alphaId,
        state: 'held',
        heldBy: 'workflow',
      })
      world.parkedSeatId = await seedCredential({
        label: 'd-parked',
        credentialGroupId: world.alphaId,
        state: 'held',
        heldBy: 'workflow',
      })
      world.keepAliveSeatId = await seedCredential({
        label: 'e-keepalive',
        credentialGroupId: world.alphaId,
        state: 'held',
        heldBy: 'keep_alive',
        lastExercisedAt: new Date(),
      })
      world.unhealthySeatId = await seedCredential({
        label: 'f-unhealthy',
        credentialGroupId: world.alphaId,
        state: 'unhealthy',
        lastFailureReason: 'The provider rejected the stored session.',
      })
      world.coolingSeatId = await seedCredential({
        label: 'g-cooling',
        credentialGroupId: world.alphaId,
        state: 'cooling_off',
        coolingOffUntil: new Date(Date.now() + 900_000),
      })
      world.registeredSeatId = await seedCredential({
        label: 'h-registered',
        credentialGroupId: world.alphaId,
        state: 'awaiting_login',
      })
      world.betaSeatId = await seedCredential({
        label: 'i-beta',
        credentialGroupId: world.betaId,
        state: 'available',
      })

      const alphaProfile = await seedProfile('alpha-profile')
      const emptyProfile = await seedProfile('empty-profile')
      await attach(alphaProfile, world.alphaId, 1)
      await attach(emptyProfile, world.emptyId, 1)

      // Holders: one running, one paused, one parked, and the keep-alive above.
      await seedRun({
        state: 'running',
        agentCredentialId: world.runningSeatId,
        holdsLease: true,
        turnsUsed: 6,
        spendUsed: '2.5000',
        computeCostBasis: '0.7500',
      })
      await seedRun({
        state: 'paused',
        agentCredentialId: world.pausedSeatId,
        holdsLease: true,
      })
      world.parkedWorkflowId = await seedRun({
        state: 'parked_resumable',
        agentCredentialId: world.parkedSeatId,
        holdsLease: true,
        acquiredAt: new Date(Date.now() - 86_400_000),
      })

      // A finished run charged to the same seat as the running one: FR-055's aggregate has to add
      // them, which is the sum a per-credential ledger would eventually disagree with.
      await seedRun({
        state: 'succeeded',
        agentCredentialId: world.runningSeatId,
        turnsUsed: 4,
        spendUsed: '1.5000',
        computeCostBasis: '0.2500',
      })

      // Two runs waiting on alpha's group, one on the empty group, and one ad hoc run that no group
      // can clear. No queue row is written anywhere: there is no queue table.
      await seedRun({
        state: 'awaiting_credential',
        executionProfileId: alphaProfile,
        createdAt: new Date(Date.now() - 600_000),
      })
      await seedRun({ state: 'awaiting_credential', executionProfileId: alphaProfile })
      await seedRun({ state: 'awaiting_credential', executionProfileId: emptyProfile })
      await seedRun({ state: 'awaiting_credential' })
    }, 90_000)

    afterAll(async () => {
      await fixtures.close()
    }, 30_000)

    describe('who may look (FR-053, data-model.md → Access scoping)', () => {
      it('refuses a non-administrator entirely, and records the denial', async () => {
        denials.length = 0

        await expect(asEngineer().view({})).rejects.toMatchObject({ code: 'FORBIDDEN' })

        // The read is refused, not merely the writes — there are no writes here. Credential
        // configuration is admin-only even where 002 would have scoped it to a profile's grantees: a
        // seat's state tells an engineer nothing they can act on, and the one fact that is theirs —
        // that their own run is waiting — reaches them through the workflow view.
        expect(denials).toHaveLength(1)
        expect(denials[0]).toMatchObject({ reason: 'not_admin', path: 'view', userId: engineer.id })
      })
    })

    describe('the pool, grouped (FR-053)', () => {
      it('groups every seat under the credential group it belongs to', async () => {
        const view = await asAdmin().view({})
        const names = view.groups.map((group) => group.credentialGroupName)

        expect(names).toStrictEqual([named('alpha'), named('beta'), named('vacant')])
        expect(view.groups[0]?.seats).toHaveLength(8)
        expect(view.groups[1]?.seats).toHaveLength(1)
        expect(view.groups[2]?.seats).toHaveLength(0)
      })

      it('keeps every credential state distinguishable, with what each one needs (FR-053, FR-075)', async () => {
        const view = await asAdmin().view({})
        const alpha = view.groups[0]
        const byId = new Map(alpha.seats.map((seat) => [seat.id, seat]))

        expect(byId.get(world.freeSeatId)).toMatchObject({
          state: 'available',
          health: 'healthy',
          selectable: true,
        })
        expect(byId.get(world.runningSeatId)).toMatchObject({
          state: 'held',
          health: 'healthy',
          selectable: false,
        })
        expect(byId.get(world.registeredSeatId)).toMatchObject({
          state: 'awaiting_login',
          health: 'never_logged_in',
          selectable: false,
        })

        // FR-075's distinction, and the one a screen most easily loses: broken needs a human,
        // rate-limited clears by itself. So `unhealthy` carries the provider's own words (FR-009) and
        // `cooling_off` carries the time it is expected back (FR-078).
        expect(byId.get(world.unhealthySeatId)).toMatchObject({
          state: 'unhealthy',
          health: 'unhealthy',
          lastFailureReason: 'The provider rejected the stored session.',
        })
        const cooling = byId.get(world.coolingSeatId)
        expect(cooling?.health).toBe('cooling_off')
        expect(cooling?.coolingOffUntil).toBeInstanceOf(Date)
      })

      it('reports each seat’s hold duration from its lease, not from the page’s memory', async () => {
        const view = await asAdmin().view({})
        const parked = view.groups[0]?.seats.find((seat) => seat.id === world.parkedSeatId)

        expect(parked?.holder?.workflowId).toBe(world.parkedWorkflowId)
        // Seeded a day ago. This is the figure the FR-056 lease-hold alert is raised against, which is
        // why the view reports the duration rather than leaving an administrator to subtract dates.
        expect(parked?.holder?.heldForMs ?? 0).toBeGreaterThan(80_000_000)
      })
    })

    describe('holders, broken down (FR-074)', () => {
      it('distinguishes running, paused, parked and keep-alive holders', async () => {
        const view = await asAdmin().view({})
        const alpha = view.groups[0]

        expect(alpha.holders).toStrictEqual({
          running: 1,
          paused: 1,
          parked: 1,
          keepAlive: 1,
          other: 0,
          total: 4,
        })
      })

      it('names the parked holder’s run, because that is what makes a full pool explicable', async () => {
        // A parked holder shows no activity and consumes capacity indefinitely (FR-019, FR-073). Any
        // summary that counted only "in use" would make this pool look idle, and the queue on it a
        // mystery.
        const view = await asAdmin().view({})
        const parked = view.groups[0]?.seats.find((seat) => seat.id === world.parkedSeatId)

        expect(parked?.holder).toMatchObject({
          kind: 'parked',
          workflowState: 'parked_resumable',
          workflowId: world.parkedWorkflowId,
        })
      })

      it('does not mistake a keep-alive for a stuck seat (FR-035, FR-038)', async () => {
        const view = await asAdmin().view({})
        const keepAlive = view.groups[0]?.seats.find((seat) => seat.id === world.keepAliveSeatId)

        // A routine exercise read as a parked holder sends an administrator looking for a run to
        // force-release that does not exist. It holds no lease, and it never will: a keep-alive has
        // no workflow to hold one for.
        expect(keepAlive?.holder).toMatchObject({ kind: 'keep_alive', workflowId: null })
      })
    })

    describe('the queue, per group, with no queue table (FR-054, SC-011)', () => {
      it('derives depth and longest wait from the runs that are waiting', async () => {
        const view = await asAdmin().view({})
        const alpha = view.groups[0]

        expect(alpha.queue.depth).toBe(2)
        // The oldest of the two was seeded ten minutes ago; the wait is measured from `created_at`,
        // which is the only record of when the run started waiting.
        expect(alpha.queue.longestWaitMs).toBeGreaterThan(500_000)
        expect(view.groups[1]?.queue.depth).toBe(0)
        expect(view.groups[2]?.queue.depth).toBe(1)
      })

      it('counts the platform’s waiting runs once each, and keeps the ad hoc one out of every group', async () => {
        const view = await asAdmin().view({})

        // Four waiting runs: two on alpha, one on the empty group, one launched without a profile.
        expect(view.queue.depth).toBe(4)
        expect(view.queue.unattributableDepth).toBe(1)
      })

      it('tells an under-sized group from an under-sized pool (SC-011)', async () => {
        const view = await asAdmin().view({})

        // `beta` still has a free seat, so the platform is not out of capacity — these runs simply
        // cannot draw on it, because their profiles are attached elsewhere (FR-063). Buying
        // platform-wide capacity would not clear this queue; buying into the named groups would.
        expect(view.verdict).toBe(GROUP_UNDERSIZED)
        expect(view.starvedGroupNames).toStrictEqual([named('alpha'), named('vacant')])
        expect(view.groups.map((group) => group.pressure)).toStrictEqual([
          'starved',
          'available',
          'starved',
        ])
      })
    })

    describe('consumption, per credential (FR-055)', () => {
      it('adds up every run that named this seat, by the join and not by a ledger', async () => {
        const view = await asAdmin().view({})
        const running = view.groups[0]?.seats.find((seat) => seat.id === world.runningSeatId)

        // Two runs charged to this seat: one in flight, one finished. A finished run's spend does not
        // stop being attributable to the identity that incurred it (FR-059).
        expect(running?.consumption).toStrictEqual({
          workflowCount: 2,
          turnsUsed: 10,
          spendUsed: '4.0000',
          computeCostBasis: '1.0000',
        })
      })

      it('reports a seat nothing has been charged to as having consumed nothing', async () => {
        const view = await asAdmin().view({})
        const free = view.groups[0]?.seats.find((seat) => seat.id === world.freeSeatId)

        expect(free?.consumption.workflowCount).toBe(0)
        expect(free?.consumption.spendUsed).toBe('0.0000')
      })
    })

    describe('nothing here notifies anybody (FR-079)', () => {
      it('renders a queue, a cooling-off seat and a parked holder without emitting a single event', async () => {
        const before = notifier.calls.length

        const view = await asAdmin().view({})

        // The three states FR-079 names are all present in this view — runs are waiting, a seat is
        // cooling off, and a parked run is holding one — and the workflow's owner hears about none of
        // them. They are reported here and on the workflow view, and pushed nowhere: waiting and
        // cooling off usually resolve in seconds without anyone acting, and notifying on them trains
        // people to ignore the channel that carries the outcomes.
        expect(view.queue.depth).toBeGreaterThan(0)
        expect(view.groups[0]?.seats.some((seat) => seat.health === 'cooling_off')).toBe(true)
        expect(view.groups[0]?.holders.parked).toBe(1)

        // Administrator alerting under FR-056 is unaffected, and is a different path with a different
        // audience — see `packages/sisyphus-notify/src/credential-alerts.ts`, which is where the four
        // conditions that *do* reach a person are decided.
        expect(notifier.calls).toHaveLength(before)
      })
    })

    describe('archived seats (FR-005)', () => {
      it('leaves them out of capacity by default, and can be asked for them', async () => {
        const archivedId = await seedCredential({
          label: 'i-archived',
          credentialGroupId: world.betaId,
          state: 'available',
        })
        await fixtures
          .db()
          .update(agentCredentials)
          .set({ archivedAt: new Date(), enabled: false })
          .where(eq(agentCredentials.id, archivedId))

        const hidden = await asAdmin().view({})
        expect(hidden.groups[1]?.seats.map((seat) => seat.id)).toStrictEqual([world.betaSeatId])

        const shown = await asAdmin().view({ includeArchived: true })
        const beta = shown.groups[1]
        expect(beta.seats.map((seat) => seat.id).sort()).toStrictEqual(
          [world.betaSeatId, archivedId].sort(),
        )
        // Present as a historical record and excluded from the capacity figures, because an archived
        // credential is not a seat anybody can be given.
        expect(beta.seatCount).toBe(1)
        expect(beta.selectableCount).toBe(1)
      })
    })
  },
)
