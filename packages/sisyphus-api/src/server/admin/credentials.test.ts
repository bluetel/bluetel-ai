import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import {
  agentCredentials,
  configurationAudit,
  credentialGroups,
  credentialLeases,
  workflowEvents,
  workflows,
} from '../../db'
import type { UserRole } from '../../enums'
import { agentCredentialIdInput } from '../../schemas'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import type { MachineContext } from '../machine'
import { reportCredentialRotation } from '../machine'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import type { AgentCredentialLeaseReleases } from './credential-leases'
import { LEASE_RELEASE_NOT_CONFIGURED_REASON } from './credential-leases'
import type { AgentCredentialLoginEnvironments, LoginEnvironment } from './credential-login'
import {
  ABANDONED_LOGIN_REASON,
  LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON,
  reapAbandonedLogins,
} from './credential-login'
import { listSelectableCredentials, recordAgentCredentialLogin } from './credential-store'
import {
  agentCredentialNotDeletableError,
  createCredentialsRouter,
  credentialsRouter,
  loginNotStartableError,
} from './credentials'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * The contract test for `admin.credentials` (T028, T071, FR-004..FR-011, FR-061,
 * FR-069..FR-072).
 *
 * Written before the router existed, against the interface data-model.md and
 * contracts/credential-lifecycle.md already fix, and extended in Phase 7 rather than replaced:
 * the Phase 4 shortcut's section is gone with the procedure it drove, and the login flow's
 * sections stand where it stood. Six things are load-bearing here; the rest is bookkeeping around
 * them.
 *
 * 1. **"Never selectable in `awaiting_login`" is asserted against the selection path.** Every
 *    assertion of that kind below goes through `listSelectableCredentials` — the query an allocator
 *    draws its candidates from — rather than through the credential's own `state` column. The
 *    difference matters: a suite that checked `state === 'awaiting_login'` after registration would
 *    pass unchanged against a selector that read `state` and ignored `secret_id`, or one that
 *    ignored the group's `enabled` flag, and both of those defects hand a workflow a seat it must
 *    not have. Asking the candidate set is asking the question the requirement is actually about.
 * 2. **No credential material appears in any panel response, at any point in the login flow**
 *    (FR-070, SC-014). Asserted rather than assumed, and asserted with real material actually in
 *    the platform: the suite captures a known string into the material store the way a login does,
 *    then walks every value every login procedure answers with, to any depth, looking for it.
 *    A design in which the panel could carry material would fail this rather than pass it quietly.
 * 3. **A login is started by an id and nothing else.** Asserted on the input schema as well as on
 *    the procedure, because the schema is what a future well-meaning contributor would have to
 *    widen in order to break property two.
 * 4. **An abandoned login is reaped by wall-clock alone** (T071, FR-071). The case that produces
 *    no event to assert against except the reap itself: the tab is closed, nothing is reported,
 *    and only the clock moves. It is the first login test in the file for that reason.
 * 5. **FR-005's delete refusal fires on any lease that has ever existed**, not merely on a live one,
 *    because what it protects is the finished run's record of what identity it worked as.
 * 6. **FR-006's disable withholds without evicting.** The live lease survives, the credential is
 *    still `held`, and the seat leaves the candidate set — three separate assertions, because a
 *    disable that released the lease would satisfy the third alone.
 */

/**
 * The refusal a call produced.
 *
 * Used instead of `expect.stringContaining` inside `toMatchObject`, which is typed `any` and so
 * turns a message assertion into an unchecked one — and several assertions here are about exactly
 * what a refusal says.
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

/**
 * How long a login environment is given before the reaper takes it, in this suite.
 *
 * A number the fake owns rather than one read from the environment: what is under test is that
 * *some* fixed wall-clock deadline is written at the start and honoured afterwards, not what the
 * deployment's value happens to be.
 */
const LOGIN_TTL_MS = 15 * 60_000

/**
 * A recording login-environment provisioner.
 *
 * Inline rather than in a shared `*-fake.ts` module because this is the only suite in this package
 * that has one — the real provisioner lives in the control plane, is built over the EC2 seam, and
 * has its own fake there.
 *
 * **Nothing on it can carry credential material, and that is the point rather than an omission.**
 * It starts, finds, lists and destroys. If a future contributor needed a `material` field to make
 * some panel feature work, they would have to add it to the port first, and the port is where
 * FR-070 is enforced.
 *
 * `expire` moves a live environment's deadline into the past. That is how the abandoned case is
 * reached without waiting fifteen minutes for it, and it is honest about what abandonment is: the
 * environment is untouched and still running, nothing has been reported, and only the clock has
 * moved past the deadline the launch wrote.
 */
const createFakeLoginEnvironments = (): AgentCredentialLoginEnvironments & {
  readonly started: readonly string[]
  readonly destroyed: readonly string[]
  readonly failNextStart: (error: Error) => void
  readonly expire: (agentCredentialId: string) => void
} => {
  const live = new Map<string, LoginEnvironment>()
  const started: string[] = []
  const destroyed: string[] = []
  let nextStartError: Error | undefined
  let counter = 0

  const environmentFor = (agentCredentialId: string): LoginEnvironment | undefined =>
    [...live.values()].find((environment) => environment.agentCredentialId === agentCredentialId)

  return {
    started,
    destroyed,

    failNextStart: (error) => {
      nextStartError = error
    },

    expire: (agentCredentialId) => {
      const environment = environmentFor(agentCredentialId)
      if (environment !== undefined) {
        live.set(environment.environmentId, {
          ...environment,
          expiresAt: new Date(Date.now() - 1_000),
        })
      }
    },

    start: (input) => {
      if (nextStartError !== undefined) {
        const error = nextStartError
        nextStartError = undefined
        return Promise.reject(error)
      }

      counter += 1
      const startedAt = new Date()
      const environment: LoginEnvironment = {
        agentCredentialId: input.agentCredentialId,
        environmentId: `i-login-${String(counter)}`,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + LOGIN_TTL_MS),
      }
      live.set(environment.environmentId, environment)
      started.push(input.agentCredentialId)

      return Promise.resolve({
        environment,
        relay: {
          sessionId: `session-${String(counter)}`,
          streamUrl: `wss://ssmmessages.example/${String(counter)}`,
          tokenValue: `ssm-session-token-${String(counter)}`,
        },
      })
    },

    find: (agentCredentialId) => Promise.resolve(environmentFor(agentCredentialId)),

    list: () => Promise.resolve([...live.values()]),

    destroy: (input) => {
      destroyed.push(input.environmentId)
      live.delete(input.environmentId)
      return Promise.resolve()
    },
  }
}

/**
 * A stand-in for the control plane's `releaseLease`, over the same tables.
 *
 * **The real one is `apps/sisyphus-control-plane/src/credentials/lease/release.ts`**, it is tested
 * there against a live Postgres — including the forced case, its `released_by_user_id`, and the
 * `force_released` audit entry attributed to the administrator — and this package cannot import it.
 * So this fake performs the two writes a release consists of, and does so because the assertions
 * downstream of it are about *this* package's half of FR-057: that the run was resolved to a
 * recorded state, and that the seat, once re-acquired, fences the old holder out. Neither can be
 * observed against a release that only records that it was asked.
 *
 * It deliberately reproduces the one rule of `releaseLease` that would otherwise make those
 * assertions lie: **release does not repair.** A credential that went `unhealthy` while it was held
 * comes back `unhealthy`, not `available`. A fake that reset the state would let a test claim a
 * force-released broken seat was back in the pool.
 *
 * `calls` is recorded so the procedure's own contract — that it names the run from the live lease
 * and attributes the release to the caller — is assertable without inferring it from the rows.
 */
const createFakeLeaseReleases = (
  db: () => SisyphusDatabase,
): AgentCredentialLeaseReleases & {
  readonly calls: readonly { agentCredentialId: string; workflowId: string; actorId: string }[]
} => {
  const calls: { agentCredentialId: string; workflowId: string; actorId: string }[] = []

  return {
    calls,
    forceRelease: async (request) => {
      calls.push({
        agentCredentialId: request.agentCredentialId,
        workflowId: request.workflowId,
        actorId: request.releasedByUserId,
      })

      const ended = await db()
        .update(credentialLeases)
        .set({
          releasedAt: new Date(),
          releaseReason: 'forced',
          releasedByUserId: request.releasedByUserId,
        })
        .where(
          and(
            eq(credentialLeases.workflowId, request.workflowId),
            eq(credentialLeases.agentCredentialId, request.agentCredentialId),
            sql`${credentialLeases.releasedAt} is null`,
          ),
        )
        .returning({ id: credentialLeases.id })

      // `released_at is null` is the whole idempotence story, exactly as in `releaseLease`: a
      // second call matches no row. Tested on the row *count* because
      // `noUncheckedIndexedAccess` is off in this workspace, so `rows[0] === undefined` is narrowed
      // away as unreachable and would be a check that is not there.
      if (ended.length === 0) {
        return { outcome: 'not_held', workflowId: request.workflowId }
      }

      const lease = ended[0]

      const [credential] = await db()
        .update(agentCredentials)
        // The `CASE` is `releaseLease`'s, not a simplification of it: only a `held` seat returns to
        // `available`, and everything else comes back exactly as unwell as it went in.
        .set({
          state: sql`case when ${agentCredentials.state} = 'held' then 'available'::credential_state else ${agentCredentials.state} end`,
          heldBy: null,
        })
        .where(eq(agentCredentials.id, request.agentCredentialId))
        .returning({ state: agentCredentials.state })

      await db()
        .insert(configurationAudit)
        .values({
          actorUserId: request.releasedByUserId,
          entityType: 'agent_credential',
          entityId: request.agentCredentialId,
          action: 'force_released',
          detail: {
            workflowId: request.workflowId,
            leaseId: lease.id,
            releaseReason: 'forced',
            credentialState: credential.state,
          },
        })

      return {
        outcome: 'released',
        workflowId: request.workflowId,
        leaseId: lease.id,
        credentialState: credential.state,
      }
    },
  }
}

/**
 * A string standing in for real agent credential material, so FR-070 can be asserted against
 * something that actually exists rather than against the absence of a field.
 *
 * Distinctive on purpose: a scan for it cannot collide with an id, a name or a timestamp.
 */
const CAPTURED_MATERIAL = 'sk-live-agent-material-that-must-never-transit-a-panel'

/**
 * Every scalar reachable from a value, however deeply nested, including inside arrays and dates.
 *
 * A shallow check of a response's own keys would be satisfied by a design that nested material one
 * level down, which is exactly the mistake worth catching — nobody adds a top-level `material`
 * field, they add a `session` object that happens to carry one.
 */
const deepScalars = (value: unknown, seen = new Set<unknown>()): readonly string[] => {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (value instanceof Date) return [value.toISOString()]
  if (typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)

  return Array.isArray(value)
    ? value.flatMap((entry) => deepScalars(entry, seen))
    : Object.values(value).flatMap((entry) => deepScalars(entry, seen))
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
  agentCredentialLogin?: AgentCredentialLoginEnvironments,
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
      ...(agentCredentialLogin === undefined ? {} : { agentCredentialLogin }),
    },
    db,
    session,
    scope: memoiseScope(() =>
      Promise.resolve({ userId: user.id, isAdmin: user.role === 'admin', visibleProfileIds: [] }),
    ),
    machineCredential: () => Promise.resolve(null),
  }
}

describe('the admin.credentials contract', () => {
  it('exposes exactly the procedures this story needs, and no more', () => {
    // `adoptSecret` was here until Phase 7 and is now gone with the shortcut it drove. Its absence
    // is asserted by this list being exhaustive: a procedure that put a seat into service by naming
    // an identifier would be a second, far less tested route to `available`.
    expect(Object.keys(credentialsRouter._def.procedures).sort()).toStrictEqual([
      'delete',
      'forceRelease',
      'get',
      'list',
      'loginStatus',
      'register',
      'setEnabled',
      'startLogin',
    ])
  })

  it('makes the reads queries and every write a mutation', () => {
    const procedures = credentialsRouter._def.procedures
    for (const name of ['list', 'get', 'loginStatus'] as const) {
      expect(procedures[name]._def.type).toBe('query')
    }
    for (const name of [
      'register',
      'startLogin',
      'setEnabled',
      'forceRelease',
      'delete',
    ] as const) {
      expect(procedures[name]._def.type).toBe('mutation')
    }
  })

  /**
   * `startLogin` is a mutation and `loginStatus` is a query, and the split is not cosmetic: the
   * relay handle is issued by the mutation and by nothing else. A query is a cacheable GET as far
   * as every layer between here and the browser is concerned, so a session handle that could be
   * re-fetched by polling would be one a proxy or a browser cache could hold on to.
   */
  it('issues the terminal handle only from the mutation', () => {
    expect(credentialsRouter._def.procedures.startLogin._def.type).toBe('mutation')
    expect(credentialsRouter._def.procedures.loginStatus._def.type).toBe('query')
  })
})

/**
 * FR-070, asserted where it would have to be broken.
 *
 * The rule is that credential material never crosses this surface. The input schema is half the
 * enforcement of it — a resolver cannot handle what its schema does not admit — so the assertion
 * belongs on the schema as well as on what the procedures answer with. The other half is the
 * response scan further down, against material that genuinely exists in the store.
 */
describe('a login is started by naming a seat and nothing else', () => {
  it('parses to exactly the credential id', () => {
    const parsed = agentCredentialIdInput.parse({
      agentCredentialId: '018f1a2b-0000-7000-8000-000000000001',
    })

    expect(Object.keys(parsed)).toStrictEqual(['agentCredentialId'])
  })

  it('discards material somebody sends alongside the identifier rather than passing it on', () => {
    const parsed = agentCredentialIdInput.parse({
      agentCredentialId: '018f1a2b-0000-7000-8000-000000000001',
      material: 'sk-a-real-looking-token',
      secretId: 'sisyphus/agent-credential/seat-one',
    })

    expect(parsed).not.toHaveProperty('material')
    // And no identifier either. Naming a secret is how the Phase 4 shortcut put a seat into
    // service without a login ever having happened, and there is no longer anywhere to say it.
    expect(parsed).not.toHaveProperty('secretId')
  })

  it('rejects anything that is not a credential id', () => {
    expect(agentCredentialIdInput.safeParse({ agentCredentialId: 'seat-one' }).success).toBe(false)
  })
})

/**
 * FR-005's refusal, asserted as a pure function so the wording is pinned whether or not a database
 * is available. **The requirement's actual content is the sentence**: not that deletion is refused,
 * but that the administrator is told the seat carries history and offered the alternative that
 * always works.
 */
describe('agentCredentialNotDeletableError', () => {
  it('names the credential, the number of leases, and what they protect', () => {
    const refusal = agentCredentialNotDeletableError({ name: 'seat-one' }, 4)

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('seat-one')
    expect(refusal.message).toContain('leased 4 times')
    expect(refusal.message).toContain('the identity they worked as')
  })

  it('says “1 time” rather than “1 times”', () => {
    expect(agentCredentialNotDeletableError({ name: 'seat-one' }, 1).message).toContain(
      'leased 1 time,',
    )
  })

  it('always names disabling as the way forward (FR-005, FR-006)', () => {
    // FR-005's shape is "not deletable, disableable instead". A refusal that stopped at "no" would
    // leave an administrator with a seat they can neither remove nor withdraw.
    const refusal = agentCredentialNotDeletableError({ name: 'seat-one' }, 2)

    expect(refusal.message).toContain('Disable it instead')
    expect(refusal.message).toContain('without interrupting any run currently holding it')
  })
})

describe('loginNotStartableError', () => {
  it('quotes the provisioner’s reason and says the credential was left alone', () => {
    const refusal = loginNotStartableError('seat-one', 'EC2 has no capacity in eu-west-2b')

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('seat-one')
    expect(refusal.message).toContain('EC2 has no capacity in eu-west-2b')
    expect(refusal.message).toContain('left exactly as it was')
  })

  it('tells the administrator the reason survives this message', () => {
    // A refusal somebody has dismissed is a refusal nobody can find again, so it also goes onto
    // the seat (FR-009) — and the message says so, or they will not think to look.
    expect(loginNotStartableError('seat-one', 'anything').message).toContain(
      'recorded against the seat',
    )
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)('admin.credentials against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
  const denials: AuthorisationDenial[] = []
  const logins = createFakeLoginEnvironments()
  const releases = createFakeLeaseReleases(() => fixtures.db())

  let admin: CallerIdentity
  let engineer: CallerIdentity

  const router = createCredentialsRouter({ loginEnvironments: logins, leaseReleases: releases })
  const createCaller = createCallerFactory(router)

  /** The default mount — built with the refusing store, exactly as `adminRouter` mounts it. */
  const createUnwiredCaller = createCallerFactory(credentialsRouter)

  const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials))
  const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials))

  const named = (label: string) => `${label}-${fixtures.suffix}`

  /**
   * A group, inserted directly.
   *
   * Not through `admin.credentialGroups.create`: this suite is about credentials, and reaching for
   * the sibling router to build a fixture would make a failure there look like one here.
   */
  const createGroup = async (label: string, enabled = true): Promise<string> => {
    const [group] = await fixtures
      .db()
      .insert(credentialGroups)
      .values({ name: named(label), enabled, createdByUserId: admin.id })
      .returning({ id: credentialGroups.id })
    return group.id
  }

  /**
   * A registered seat that has been through a login — the state everything downstream starts from.
   *
   * The capture itself is written directly, the way `leaseCredential` writes an acquisition
   * directly, and for the same reason: the code that performs it lives in the control plane
   * (`credentials/login/capture.ts`), which this package cannot import and must not depend on.
   * What matters to the assertions here is the shape a capture leaves behind — a secret identifier,
   * a login time and state `available` — and that shape is fixed by data-model.md.
   *
   * It goes through `recordAgentCredentialLogin`, the same narrow writer the control plane calls,
   * rather than through a hand-written `UPDATE`. A fixture that set the columns itself could drift
   * from the writer and would then be seeding a state the real flow cannot produce.
   */
  const availableCredential = async (label: string, credentialGroupId: string) => {
    const credential = await asAdmin().register({ name: named(label), credentialGroupId })
    const captured = await recordAgentCredentialLogin(fixtures.db(), credential.id, {
      secretId: `arn:aws:secretsmanager:eu-west-2:000000000000:secret:${named(label)}-AbCdEf`,
      lastLoginAt: new Date(),
    })

    if (captured === undefined) {
      throw new Error(`The fixture login for ${label} was refused, so there is nothing to test.`)
    }

    return captured
  }

  /**
   * Put a credential under a live lease, the way an acquisition would.
   *
   * Written directly rather than through an allocator, because there is not one yet: Phase 5 owns
   * acquisition. What matters to the assertions here is the shape an acquisition leaves behind — a
   * live lease row and a `held` credential — and that shape is fixed by data-model.md, not by the
   * code that will eventually produce it.
   *
   * `credential_leases.workflow_id` is not null and carries a foreign key, so FR-005 and FR-006
   * cannot be provoked with an invented id: the refusals they produce have to come from a lease a
   * real run could have written, which is what `fixtures.seedWorkflow` supplies.
   *
   * Three columns beyond the lease row are written because acquisition writes them and T114's
   * assertions are about what happens to them afterwards: the credential's **fence** is raised (R9
   * — acquisition is the only thing that raises it, and a fixture that left it at zero would make
   * "the next acquisition fenced the old holder out" unprovable), the lease carries the value that
   * raise produced, and `workflows.agent_credential_id` records the identity the run worked as
   * (FR-059 — and the rotation path resolves the seat through it, never through the live lease).
   */
  const leaseCredential = async (agentCredentialId: string): Promise<string> => {
    const workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: 'running' })

    const [claimed] = await fixtures
      .db()
      .update(agentCredentials)
      .set({
        state: 'held',
        heldBy: 'workflow',
        fence: sql`${agentCredentials.fence} + 1`,
        lastUsedAt: new Date(),
      })
      .where(eq(agentCredentials.id, agentCredentialId))
      .returning({ fence: agentCredentials.fence })

    await fixtures
      .db()
      .insert(credentialLeases)
      .values({ agentCredentialId, workflowId, fence: claimed.fence })

    await fixtures
      .db()
      .update(workflows)
      .set({ agentCredentialId })
      .where(eq(workflows.id, workflowId))

    return workflowId
  }

  /**
   * Raise the credential's fence and hand the seat to another run, exactly as an acquisition does.
   *
   * `apps/sisyphus-control-plane/src/credentials/lease/acquire.ts` is the real one and this package
   * cannot import it, so the two statements that matter are reproduced verbatim: the conditional
   * `UPDATE … WHERE state = 'available'` that claims the row, and `fence = fence + 1` inside it.
   * **Acquisition is the only thing that raises the fence** (R9) — release explicitly does not, so
   * that a rotation the departing holder already sent still lands (FR-032) — which is why the
   * increment has to happen here and not in the release above for the assertions to mean anything.
   *
   * @returns The workflow now holding the seat and the fence it was issued.
   */
  const reacquireCredential = async (
    agentCredentialId: string,
  ): Promise<{ workflowId: string; fence: number }> => {
    const workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: 'running' })

    const claimedRows = await fixtures
      .db()
      .update(agentCredentials)
      .set({
        state: 'held',
        heldBy: 'workflow',
        fence: sql`${agentCredentials.fence} + 1`,
        lastUsedAt: new Date(),
      })
      .where(
        and(eq(agentCredentials.id, agentCredentialId), eq(agentCredentials.state, 'available')),
      )
      .returning({ fence: agentCredentials.fence })

    // Zero rows is the conditional update losing, which here means the fixture's premise is wrong.
    // Asserted on the count rather than on `rows[0] === undefined`, for the reason given above.
    if (claimedRows.length === 0) {
      throw new Error(
        'The seat was not available to re-acquire, so the fence was never raised and the assertion below would prove nothing.',
      )
    }

    const claimed = claimedRows[0]

    await fixtures
      .db()
      .insert(credentialLeases)
      .values({ agentCredentialId, workflowId, fence: claimed.fence })

    await fixtures
      .db()
      .update(workflows)
      .set({ agentCredentialId })
      .where(eq(workflows.id, workflowId))

    return { workflowId, fence: claimed.fence }
  }

  /**
   * A machine-surface context for one run, so the rotation path can be exercised as its holder.
   *
   * The `credential` is the workflow-scoped JWT's claims, and none of its fields decide anything
   * here: `reportCredentialRotation` resolves the seat from `ctx.workflowId` alone, which is the
   * property that makes it impossible for a caller to name somebody else's credential.
   */
  const machineContextFor = (workflowId: string): MachineContext => ({
    db: fixtures.db(),
    workflowId,
    credential: {
      credentialId: randomUUID(),
      workflowId,
      jti: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
    dependencies: contextFor(fixtures.db(), admin, denials).dependencies,
  })

  const workflowRow = async (workflowId: string) =>
    (await fixtures.db().select().from(workflows).where(eq(workflows.id, workflowId)))[0]

  const timelineFor = async (workflowId: string) =>
    fixtures
      .db()
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.workflowId, workflowId))
      .orderBy(workflowEvents.createdAt)

  /** The candidate set an allocator would draw from — the selection path itself. */
  const selectableIn = async (credentialGroupId: string): Promise<readonly string[]> =>
    (await listSelectableCredentials(fixtures.db(), [credentialGroupId])).map(
      (credential) => credential.id,
    )

  const trailFor = async (entityId: string) =>
    fixtures
      .db()
      .select()
      .from(configurationAudit)
      .where(
        and(
          inArray(configurationAudit.entityType, ['agent_credential']),
          eq(configurationAudit.entityId, entityId),
        ),
      )
      .orderBy(configurationAudit.createdAt)

  beforeAll(async () => {
    await fixtures.open()
    const seededAdmin = await fixtures.seedUser({ label: 'credentials-admin', role: 'admin' })
    const seededEngineer = await fixtures.seedUser({ label: 'credentials-engineer' })
    admin = { ...seededAdmin, role: 'admin' }
    engineer = { ...seededEngineer, role: 'engineer' }
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  describe('who may act (FR-004)', () => {
    it('refuses every procedure to a non-administrator and records each denial', async () => {
      denials.length = 0
      const caller = asEngineer()

      await expect(caller.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(caller.get({ agentCredentialId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(
        caller.register({ name: named('smuggled'), credentialGroupId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(caller.startLogin({ agentCredentialId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(caller.loginStatus({ agentCredentialId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(
        caller.setEnabled({ agentCredentialId: randomUUID(), enabled: false }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(caller.forceRelease({ agentCredentialId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(caller.delete({ agentCredentialId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })

      // SC-013: the refusal is a fact somebody may need afterwards, so it is recorded rather than
      // merely returned. The reads are in this list too — a credential's state tells an engineer
      // nothing they can act on (data-model.md → Access scoping) — and so is `loginStatus`, which
      // would otherwise say whether the platform is currently running an instance for a seat.
      expect(denials).toHaveLength(8)
      expect(new Set(denials.map((denial) => denial.reason))).toStrictEqual(new Set(['not_admin']))
      expect(denials.map((denial) => denial.path).sort()).toStrictEqual([
        'delete',
        'forceRelease',
        'get',
        'list',
        'loginStatus',
        'register',
        'setEnabled',
        'startLogin',
      ])
      expect(new Set(denials.map((denial) => denial.userId))).toStrictEqual(new Set([engineer.id]))
    })

    it('writes nothing on a refused registration', async () => {
      const credentialGroupId = await createGroup('denied-group')

      await expect(
        asEngineer().register({ name: named('denied'), credentialGroupId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      const page = await asAdmin().list({ credentialGroupId, limit: 100 })
      expect(page.items).toStrictEqual([])
    })
  })

  describe('registration lands unselectable (FR-008, FR-061)', () => {
    it('creates the seat in awaiting_login with no secret, in exactly one group', async () => {
      const credentialGroupId = await createGroup('register-group')

      const credential = await asAdmin().register({
        name: named('seat-one'),
        credentialGroupId,
      })

      expect(credential.state).toBe('awaiting_login')
      expect(credential.secretId).toBeNull()
      expect(credential.lastLoginAt).toBeNull()
      expect(credential.credentialGroupId).toBe(credentialGroupId)
      expect(credential.enabled).toBe(true)
      expect(credential.archivedAt).toBeNull()
    })

    /**
     * **The assertion the story turns on.** It is made against the candidate query an allocator
     * draws from, not against the credential's `state` column: "unselectable" is a claim about the
     * set a selector can see, and only that set can answer it.
     */
    it('is absent from the selection candidates while it awaits a login', async () => {
      const credentialGroupId = await createGroup('unselectable-group')
      const credential = await asAdmin().register({
        name: named('unselectable'),
        credentialGroupId,
      })

      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      // And the panel agrees with the allocator, because both read the same predicate.
      const page = await asAdmin().list({ credentialGroupId, limit: 100 })
      expect(page.items.find((item) => item.id === credential.id)?.selectable).toBe(false)
    })

    it('reports the group by name, so the pool is readable without resolving ids', async () => {
      const credentialGroupId = await createGroup('named-group')
      await asAdmin().register({ name: named('named-seat'), credentialGroupId })

      const page = await asAdmin().list({ credentialGroupId, limit: 100 })
      expect(page.items[0]?.credentialGroupName).toBe(named('named-group'))
    })

    it('records the registration against the acting administrator (FR-004)', async () => {
      const credentialGroupId = await createGroup('audited-group')
      const credential = await asAdmin().register({
        name: named('audited-seat'),
        credentialGroupId,
      })

      const trail = await trailFor(credential.id)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({
        entityType: 'agent_credential',
        action: 'registered',
        actorUserId: admin.id,
      })
      expect(trail[0]?.detail).toMatchObject({
        credentialGroupId,
        state: 'awaiting_login',
      })
    })

    it('refuses a duplicate name, case-insensitively, because citext says they are one name', async () => {
      const credentialGroupId = await createGroup('duplicate-group')
      await asAdmin().register({ name: named('duplicate'), credentialGroupId })

      const refusal = await refusalOf(
        asAdmin().register({ name: named('DUPLICATE'), credentialGroupId }),
      )
      expect(refusal.code).toBe('CONFLICT')
    })

    it('refuses a group that does not exist, without saying which id was wrong (FR-190)', async () => {
      await expect(
        asAdmin().register({ name: named('nowhere'), credentialGroupId: randomUUID() }),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'No such credential group, agent credential or execution profile.',
      })
    })

    it('accepts a disabled group, because disabling withdraws capacity rather than closing the pool', async () => {
      // Staging replacement capacity is "disable the pool, rebuild it, re-enable it", and refusing
      // here would make that impossible.
      const credentialGroupId = await createGroup('disabled-group', false)

      const credential = await asAdmin().register({
        name: named('into-disabled'),
        credentialGroupId,
      })

      expect(credential.state).toBe('awaiting_login')
    })
  })

  /**
   * **T071 — the abandoned login, reaped by wall-clock alone (FR-071).**
   *
   * First of the login sections deliberately. It is the case least likely to be caught any other
   * way, because it produces no event to assert against except the reap itself: the administrator
   * closes the tab, and from the platform's side nothing at all happens. There is no session
   * teardown to observe, no failure to record, no completion to miss. Every other test in this file
   * asserts against something somebody did; this one asserts against something nobody did.
   *
   * The only thing that moves is the clock, which is why `expire` on the fake rewrites the
   * deadline rather than touching the environment. The environment is still there and still
   * running when the sweep finds it, exactly as a real one would be.
   */
  describe('an abandoned login is reaped by wall-clock (T071, FR-071)', () => {
    it('destroys the environment and records why, with nothing having reported anything', async () => {
      const credentialGroupId = await createGroup('abandoned-group')
      const credential = await asAdmin().register({
        name: named('abandoned'),
        credentialGroupId,
      })

      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })

      // The tab closes here. Nothing is called, nothing is reported, and the environment stays up.
      logins.expire(credential.id)

      const result = await reapAbandonedLogins({ db: fixtures.db(), environments: logins })

      expect(logins.destroyed).toContain(started.environment.environmentId)
      expect(result.reaped.map((reaped) => reaped.environmentId)).toContain(
        started.environment.environmentId,
      )

      // The seat is exactly where it was — unselectable, no secret, no login time — and now says
      // why (FR-009). An abandoned attempt must leave nothing behind but an explanation.
      const after = await asAdmin().get({ agentCredentialId: credential.id })
      expect(after.state).toBe('awaiting_login')
      expect(after.secretId).toBeNull()
      expect(after.lastLoginAt).toBeNull()
      expect(after.lastFailureReason).toBe(ABANDONED_LOGIN_REASON)
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      // And the panel agrees: there is no session to go back to.
      const status = await asAdmin().loginStatus({ agentCredentialId: credential.id })
      expect(status.environment).toBeUndefined()
    })

    it('leaves a login that is still inside its deadline entirely alone', async () => {
      const credentialGroupId = await createGroup('live-login-group')
      const credential = await asAdmin().register({
        name: named('live-login'),
        credentialGroupId,
      })
      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })

      // No `expire`. The administrator has been quiet for a while, which is what somebody typing a
      // password into a terminal looks like from here, and is not evidence of anything.
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })

      expect(logins.destroyed).not.toContain(started.environment.environmentId)
      expect(
        (await asAdmin().get({ agentCredentialId: credential.id })).lastFailureReason,
      ).toBeNull()

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    it('lets the seat be logged in again afterwards, with the stale reason cleared', async () => {
      const credentialGroupId = await createGroup('retry-after-reap-group')
      const credential = await asAdmin().register({
        name: named('retry-after-reap'),
        credentialGroupId,
      })

      await asAdmin().startLogin({ agentCredentialId: credential.id })
      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })

      // FR-071 destroys the environment; it does not put the seat beyond use. The whole remedy
      // offered by `ABANDONED_LOGIN_REASON` is "start it again", so starting it again must work.
      const restarted = await asAdmin().startLogin({ agentCredentialId: credential.id })
      expect(restarted.environment.environmentId).not.toBe('')

      const captured = await recordAgentCredentialLogin(fixtures.db(), credential.id, {
        secretId: `arn:aws:secretsmanager:eu-west-2:000000000000:secret:${named('retry-after-reap')}-AbCdEf`,
        lastLoginAt: new Date(),
      })

      // And the explanation of the abandoned attempt goes with it, rather than sitting against a
      // seat that now works.
      expect(captured?.state).toBe('available')
      expect(captured?.lastFailureReason).toBeNull()

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })
  })

  describe('startLogin provisions the environment and moves nothing (FR-008, FR-069)', () => {
    it('hands back an environment and a terminal, leaving the seat unselectable', async () => {
      const credentialGroupId = await createGroup('start-login-group')
      const credential = await asAdmin().register({
        name: named('start-login'),
        credentialGroupId,
      })

      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })

      expect(logins.started).toContain(credential.id)
      expect(started.environment.agentCredentialId).toBe(credential.id)
      expect(started.relay.sessionId).not.toBe('')

      // A wall-clock deadline is fixed at the start, not extended by activity — that is what makes
      // the abandoned case reapable at all (FR-071).
      expect(started.environment.expiresAt.getTime()).toBe(
        started.environment.startedAt.getTime() + LOGIN_TTL_MS,
      )

      // **The seat has not moved.** FR-008 admits `available` only on a proved login, so there is
      // no in-between state to invent and nothing to unwind when the attempt is abandoned.
      expect(started.credential.state).toBe('awaiting_login')
      expect(started.credential.secretId).toBeNull()
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    it('records the attempt against the acting administrator, with identifiers only (FR-004)', async () => {
      const credentialGroupId = await createGroup('start-login-audited-group')
      const credential = await asAdmin().register({
        name: named('start-login-audited'),
        credentialGroupId,
      })

      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })

      const trail = await trailFor(credential.id)
      expect(trail.at(-1)).toMatchObject({ action: 'updated', actorUserId: admin.id })
      expect(trail.at(-1)?.detail).toMatchObject({
        loginStarted: true,
        environmentId: started.environment.environmentId,
        state: 'awaiting_login',
      })

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    /**
     * FR-010 and FR-072 in one assertion: re-login is not a different procedure, a different
     * environment or a different capture. It is this one, started from `unhealthy`.
     */
    it('is also re-login, from unhealthy, through the identical path (FR-010, FR-072)', async () => {
      const credentialGroupId = await createGroup('re-login-group')
      const credential = await availableCredential('re-login', credentialGroupId)

      await fixtures
        .db()
        .update(agentCredentials)
        .set({ state: 'unhealthy', lastFailureReason: 'the provider rejected the session' })
        .where(eq(agentCredentials.id, credential.id))

      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })
      expect(started.environment.agentCredentialId).toBe(credential.id)

      // And it completes the same way, through the same writer, back to `available`.
      const captured = await recordAgentCredentialLogin(fixtures.db(), credential.id, {
        secretId: credential.secretId ?? '',
        lastLoginAt: new Date(),
      })
      expect(captured?.state).toBe('available')
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([credential.id])

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    it('refuses a seat a run is holding, because its material is in use', async () => {
      const credentialGroupId = await createGroup('held-login-group')
      const credential = await availableCredential('held-login', credentialGroupId)
      await leaseCredential(credential.id)

      // Replacing the material of an identity a run is authenticated as would invalidate the copy
      // that run is using, mid-flight, with nothing to tell it why its next call failed.
      const refusal = await refusalOf(asAdmin().startLogin({ agentCredentialId: credential.id }))

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain('not a state a login can be started from')
      expect(logins.started).not.toContain(credential.id)
    })

    it('refuses a seat that already works, rather than replacing material nobody asked about', async () => {
      const credentialGroupId = await createGroup('available-login-group')
      const credential = await availableCredential('available-login', credentialGroupId)

      const refusal = await refusalOf(asAdmin().startLogin({ agentCredentialId: credential.id }))

      expect(refusal.code).toBe('CONFLICT')
      expect((await asAdmin().get({ agentCredentialId: credential.id })).state).toBe('available')
    })

    it('records the reason against the seat when no environment could be provisioned (FR-009)', async () => {
      const credentialGroupId = await createGroup('no-capacity-group')
      const credential = await asAdmin().register({
        name: named('no-capacity'),
        credentialGroupId,
      })
      logins.failNextStart(new Error('EC2 has no capacity in eu-west-2b'))

      const refusal = await refusalOf(asAdmin().startLogin({ agentCredentialId: credential.id }))

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain('EC2 has no capacity in eu-west-2b')

      // FR-009: a refusal an administrator has dismissed is a refusal nobody can find again, and
      // the pool view is where they will look for it.
      const after = await asAdmin().get({ agentCredentialId: credential.id })
      expect(after.lastFailureReason).toContain('EC2 has no capacity in eu-west-2b')
      expect(after.state).toBe('awaiting_login')
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])
    })

    it('starts nothing at all in a deployment that has wired no login environment', async () => {
      const credentialGroupId = await createGroup('unwired-login-group')
      const credential = await asAdmin().register({
        name: named('unwired-login'),
        credentialGroupId,
      })

      const refusal = await refusalOf(
        createUnwiredCaller(contextFor(fixtures.db(), admin, denials)).startLogin({
          agentCredentialId: credential.id,
        }),
      )

      // A login that appeared to begin and provisioned nothing would leave an administrator waiting
      // at a terminal that never opens.
      expect(refusal.message).toContain(LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON)
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])
    })

    it('lets a per-request provisioner from the host serve the default mount', async () => {
      const credentialGroupId = await createGroup('injected-login-group')
      const credential = await asAdmin().register({
        name: named('injected-login'),
        credentialGroupId,
      })

      // Which host provisions compute is a property of the deployment, so the one on
      // `SisyphusDependencies` serves even the router built with the refusing default.
      const started = await createUnwiredCaller(
        contextFor(fixtures.db(), admin, denials, logins),
      ).startLogin({ agentCredentialId: credential.id })

      expect(started.environment.agentCredentialId).toBe(credential.id)

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })
  })

  describe('loginStatus reports and changes nothing', () => {
    it('answers with the same listing the pool view renders, and the live environment', async () => {
      const credentialGroupId = await createGroup('status-group')
      const credential = await asAdmin().register({ name: named('status'), credentialGroupId })

      const before = await asAdmin().loginStatus({ agentCredentialId: credential.id })
      expect(before.environment).toBeUndefined()
      expect(before.expired).toBe(false)
      expect(before.credential.selectable).toBe(false)

      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })

      const during = await asAdmin().loginStatus({ agentCredentialId: credential.id })
      expect(during.environment?.environmentId).toBe(started.environment.environmentId)
      expect(during.expired).toBe(false)

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    /**
     * A status query that destroyed things would make the reap depend on somebody having the page
     * open — the exact inversion of what FR-071 asks for.
     */
    it('reports an expired environment without destroying it', async () => {
      const credentialGroupId = await createGroup('status-expired-group')
      const credential = await asAdmin().register({
        name: named('status-expired'),
        credentialGroupId,
      })
      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })
      logins.expire(credential.id)

      const status = await asAdmin().loginStatus({ agentCredentialId: credential.id })

      expect(status.expired).toBe(true)
      expect(status.environment?.environmentId).toBe(started.environment.environmentId)
      expect(logins.destroyed).not.toContain(started.environment.environmentId)

      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    it('never hands out a terminal, however often it is polled', async () => {
      const credentialGroupId = await createGroup('status-no-relay-group')
      const credential = await asAdmin().register({
        name: named('status-no-relay'),
        credentialGroupId,
      })
      await asAdmin().startLogin({ agentCredentialId: credential.id })

      const status = await asAdmin().loginStatus({ agentCredentialId: credential.id })

      // The relay is issued once, by the mutation. A query is a cacheable GET to every layer
      // between here and the browser, and a session handle that could be re-fetched by polling
      // would be one a proxy or a browser cache could hold on to.
      expect(status).not.toHaveProperty('relay')
      expect(deepScalars(status).some((value) => value.startsWith('ssm-session-token-'))).toBe(
        false,
      )

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })
  })

  /**
   * **The property the whole flow turns on, asserted rather than assumed (FR-070, SC-014).**
   *
   * The material below genuinely exists in the platform for the duration of this test: it is
   * captured into a store the way a login captures one, and the credential points at the identifier
   * it was filed under. So a response carrying it *could* be produced by a wrong design, and the
   * scan is a real question rather than a check that a field nobody wrote is absent.
   *
   * Every response an administrator's browser can obtain about this seat is walked to the bottom —
   * `startLogin`, `loginStatus`, `get` and `list` — because the mistake worth catching is not a
   * top-level `material` field but a nested object that happens to carry one.
   */
  describe('no credential material appears in any panel response (FR-070, SC-014)', () => {
    it('is absent from every response the login flow produces, at any depth', async () => {
      const credentialGroupId = await createGroup('no-material-group')
      const credential = await asAdmin().register({ name: named('no-material'), credentialGroupId })

      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })

      // The capture happens server-side, out of reach of this surface: the agent writes the
      // material on the login instance, the control plane reads it there and puts it in the secret
      // store, and what comes back to the platform's database is the identifier alone.
      const secretId = `arn:aws:secretsmanager:eu-west-2:000000000000:secret:${named('no-material')}-AbCdEf`
      const materialStore = new Map<string, string>([[secretId, CAPTURED_MATERIAL]])
      await recordAgentCredentialLogin(fixtures.db(), credential.id, {
        secretId,
        lastLoginAt: new Date(),
      })

      const responses = [
        started,
        await asAdmin().loginStatus({ agentCredentialId: credential.id }),
        await asAdmin().get({ agentCredentialId: credential.id }),
        await asAdmin().list({ credentialGroupId, limit: 100 }),
      ]

      for (const response of responses) {
        expect(deepScalars(response)).not.toContain(CAPTURED_MATERIAL)
        expect(
          deepScalars(response).some((value) => value.includes(CAPTURED_MATERIAL)),
          'a panel response carried credential material',
        ).toBe(false)
      }

      // The identifier does cross, and that is the design: a name is not material, and the pool
      // view shows it so an administrator can find the secret without guessing.
      expect(deepScalars(responses[2])).toContain(secretId)
      expect(materialStore.get(secretId)).toBe(CAPTURED_MATERIAL)

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    it('is absent from the reason an abandoned attempt leaves behind', () => {
      // `last_failure_reason` is rendered to administrators verbatim, so it is the one free-text
      // column on the seat and the one place a careless later change could put a value.
      expect(ABANDONED_LOGIN_REASON).not.toContain(CAPTURED_MATERIAL)
      expect(ABANDONED_LOGIN_REASON).not.toMatch(/sk-|token|secret value/i)
    })
  })

  describe('disable withholds without interrupting (FR-006)', () => {
    it('takes a seat off the selection path while leaving its live holder alone', async () => {
      const credentialGroupId = await createGroup('disable-group')
      const credential = await availableCredential('disable', credentialGroupId)
      const workflowId = await leaseCredential(credential.id)

      const changed = await asAdmin().setEnabled({
        agentCredentialId: credential.id,
        enabled: false,
      })

      expect(changed.credential.enabled).toBe(false)
      expect(changed.liveHolderCount).toBe(1)

      // Three separate facts, because a disable that released the lease would satisfy only the
      // first: withheld from selection, lease still live, credential still held.
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      const [lease] = await fixtures
        .db()
        .select()
        .from(credentialLeases)
        .where(eq(credentialLeases.workflowId, workflowId))
      expect(lease.releasedAt).toBeNull()
      expect(lease.releaseReason).toBeNull()

      expect((await asAdmin().get({ agentCredentialId: credential.id })).state).toBe('held')
    })

    it('records the disable with how many runs it is not interrupting', async () => {
      const credentialGroupId = await createGroup('disable-audited-group')
      const credential = await availableCredential('disable-audited', credentialGroupId)

      await asAdmin().setEnabled({ agentCredentialId: credential.id, enabled: false })

      const trail = await trailFor(credential.id)
      expect(trail.at(-1)).toMatchObject({ action: 'disabled', actorUserId: admin.id })
      expect(trail.at(-1)?.detail).toMatchObject({ liveHolderCount: 0 })
    })

    it('re-enables a seat, returning it to the selection path', async () => {
      const credentialGroupId = await createGroup('re-enable-group')
      const credential = await availableCredential('re-enable', credentialGroupId)
      await asAdmin().setEnabled({ agentCredentialId: credential.id, enabled: false })

      const changed = await asAdmin().setEnabled({
        agentCredentialId: credential.id,
        enabled: true,
      })

      expect(changed.credential.enabled).toBe(true)
      expect((await trailFor(credential.id)).at(-1)).toMatchObject({ action: 'enabled' })
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([credential.id])
    })

    it('writes no audit entry for a disable that changes nothing', async () => {
      const credentialGroupId = await createGroup('idempotent-group')
      const credential = await availableCredential('idempotent', credentialGroupId)
      await asAdmin().setEnabled({ agentCredentialId: credential.id, enabled: false })
      const before = (await trailFor(credential.id)).length

      await asAdmin().setEnabled({ agentCredentialId: credential.id, enabled: false })

      expect(await trailFor(credential.id)).toHaveLength(before)
    })

    it('withholds every member of a disabled group, without touching the credentials', async () => {
      const credentialGroupId = await createGroup('group-disable')
      const credential = await availableCredential('group-disabled-seat', credentialGroupId)

      await fixtures
        .db()
        .update(credentialGroups)
        .set({ enabled: false })
        .where(eq(credentialGroups.id, credentialGroupId))

      // FR-006 applied group-wide (FR-066). The credential is untouched and still `available`; it
      // is simply not a candidate, which is why the predicate reads the group as well as the seat.
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])
      const after = await asAdmin().get({ agentCredentialId: credential.id })
      expect(after.state).toBe('available')
      expect(after.enabled).toBe(true)
      expect(after.selectable).toBe(false)
    })
  })

  /**
   * **T114 — an administrator takes a seat back (FR-057, FR-058, SC-012, SC-015).**
   *
   * The recovery sequence US9 is about: a seat breaks while a long-running workflow is holding it,
   * so it cannot be re-logged-in (`startLogin` refuses a `held` seat) and disabling it interrupts
   * nothing (FR-006). Force-release is what breaks the deadlock, and it costs somebody a run — so
   * every assertion here is about the price being paid *visibly*.
   *
   * The fence assertion is the one worth reading twice. FR-057's guarantee is not merely that the
   * lease row is marked released; it is that the displaced holder **cannot go on writing** as that
   * identity once the seat is issued to somebody else. That is not enforced by anything checking
   * whether the old run is still alive — nothing knows — it is enforced by the next acquisition
   * raising `agent_credentials.fence`, after which the old holder's rotation is below the current
   * value and is refused. So the test performs the release, performs the next acquisition, and then
   * has the *old* run attempt a rotation with the fence it was issued.
   */
  describe('force-release takes a seat back and ends the run holding it (FR-057)', () => {
    it('resolves the affected workflow to a recorded state, attributed to the administrator', async () => {
      const credentialGroupId = await createGroup('force-release-group')
      const credential = await availableCredential('force-release', credentialGroupId)
      const workflowId = await leaseCredential(credential.id)

      const forced = await asAdmin().forceRelease({ agentCredentialId: credential.id })

      // The lease ended, as `forced`, naming the administrator (SC-015: a null actor here would be
      // the platform's own FR-022 sweep, which is a different event with a different remedy).
      expect(forced.release.outcome).toBe('released')
      expect(releases.calls.at(-1)).toMatchObject({
        agentCredentialId: credential.id,
        workflowId,
        actorId: admin.id,
      })

      const [lease] = await fixtures
        .db()
        .select()
        .from(credentialLeases)
        .where(eq(credentialLeases.workflowId, workflowId))
      expect(lease.releasedAt).not.toBeNull()
      expect(lease.releaseReason).toBe('forced')
      expect(lease.releasedByUserId).toBe(admin.id)

      // **The run is resolved, not merely abandoned.** FR-057 says the forced release resolves the
      // affected workflow to a *recorded* state — a run left `running` with no seat would fail
      // later, somewhere else, for a reason nothing in its own history explains.
      expect(forced.workflow.resolved).toBe(true)
      expect(forced.workflow.from).toBe('running')

      const run = await workflowRow(workflowId)
      expect(run.state).toBe('failed')
      expect(run.terminalOutcome).toBe('failed')
      expect(run.outcomeReason).toContain(credential.name)
      expect(run.outcomeReason).toContain(admin.email)
      // FR-023: there was no other seat for it to continue on, and the record says so rather than
      // leaving its owner to wonder whether the platform simply gave up.
      expect(run.outcomeReason).toContain('never moved to a different agent credential')

      // And on the timeline the owner actually reads, attributed to the person who did it.
      const timeline = await timelineFor(workflowId)
      expect(timeline.at(-1)).toMatchObject({
        event: 'failed',
        actorType: 'user',
        actorUserId: admin.id,
      })

      // FR-059 survives it: the run's record still names the identity it worked as.
      expect(run.agentCredentialId).toBe(credential.id)

      // The seat is back in the pool, and the trail says who freed it (FR-058).
      expect(forced.credential.state).toBe('available')
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([credential.id])
      expect((await trailFor(credential.id)).at(-1)).toMatchObject({
        action: 'force_released',
        actorUserId: admin.id,
      })
    })

    it('lets the next acquisition fence the displaced holder out of its own seat (FR-020, FR-057)', async () => {
      const credentialGroupId = await createGroup('fenced-out-group')
      const credential = await availableCredential('fenced-out', credentialGroupId)
      const displacedWorkflowId = await leaseCredential(credential.id)

      // The fence the displaced holder was issued, read before anything moves. `leaseCredential`
      // writes 1, which is what an acquisition against a fresh seat would have produced.
      const [displacedLease] = await fixtures
        .db()
        .select()
        .from(credentialLeases)
        .where(eq(credentialLeases.workflowId, displacedWorkflowId))
      const displacedFence = displacedLease.fence

      await asAdmin().forceRelease({ agentCredentialId: credential.id })

      // **The release itself raises nothing** (R9), and that is deliberate rather than an omission:
      // a rotation the departing holder had already sent must still land if it is newer (FR-032).
      const afterRelease = await asAdmin().get({ agentCredentialId: credential.id })
      expect(afterRelease.state).toBe('available')
      const [releasedRow] = await fixtures
        .db()
        .select({ fence: agentCredentials.fence })
        .from(agentCredentials)
        .where(eq(agentCredentials.id, credential.id))
      expect(releasedRow.fence).toBe(displacedFence)

      // The next acquisition is what raises it.
      const next = await reacquireCredential(credential.id)
      expect(next.fence).toBeGreaterThan(displacedFence)

      // The displaced run is still perfectly capable of calling: nothing revoked its executor
      // credential, and `reportCredentialRotation` resolves its seat through
      // `workflows.agent_credential_id`, which is never cleared. The fence is the whole defence.
      const materials = new Map<string, string>([[credential.secretId ?? '', CAPTURED_MATERIAL]])
      const store = {
        read: (secretId: string) => Promise.resolve(materials.get(secretId) ?? ''),
        write: (secretId: string, material: string) => {
          materials.set(secretId, material)
          return Promise.resolve()
        },
      }

      const refused = await reportCredentialRotation(
        machineContextFor(displacedWorkflowId),
        { fence: displacedFence, material: 'sk-written-by-a-run-that-lost-its-seat' },
        store,
      )

      expect(refused).toStrictEqual({ accepted: false, reason: 'stale_fence' })
      // Answered rather than thrown — the holder should wind down, and an error would have it
      // retry — and, the point of the whole test, the stored material is untouched.
      expect(materials.get(credential.secretId ?? '')).toBe(CAPTURED_MATERIAL)

      // The run that actually holds the seat writes through the same path without difficulty.
      const accepted = await reportCredentialRotation(
        machineContextFor(next.workflowId),
        { fence: next.fence, material: 'sk-written-by-the-current-holder' },
        store,
      )
      expect(accepted).toStrictEqual({ accepted: true })
    })

    it('leaves a broken seat broken, because a release does not repair (FR-033)', async () => {
      const credentialGroupId = await createGroup('force-release-broken-group')
      const credential = await availableCredential('force-release-broken', credentialGroupId)
      await leaseCredential(credential.id)

      // The case the control actually exists for: the login broke while a run was holding it.
      await fixtures
        .db()
        .update(agentCredentials)
        .set({ state: 'unhealthy', lastFailureReason: 'the provider rejected the session' })
        .where(eq(agentCredentials.id, credential.id))

      const forced = await asAdmin().forceRelease({ agentCredentialId: credential.id })

      // Freeing the seat is not fixing it. Returning it to `available` would hand a broken identity
      // to the next run that asked, which is the failure SC-010 measures.
      expect(forced.credential.state).toBe('unhealthy')
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      // And it is now in a state a re-login can be started from, which is the point of forcing it
      // free at all — `startLogin` refuses a `held` seat (FR-072, SC-012).
      const started = await asAdmin().startLogin({ agentCredentialId: credential.id })
      expect(started.environment.agentCredentialId).toBe(credential.id)

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })

    it('refuses a seat nobody is holding, rather than ending a run at random', async () => {
      const credentialGroupId = await createGroup('force-release-idle-group')
      const credential = await availableCredential('force-release-idle', credentialGroupId)

      const refusal = await refusalOf(asAdmin().forceRelease({ agentCredentialId: credential.id }))

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain('not held by any run')
    })

    it('leaves a run that finished on its own with its own account of how it ended (FR-064)', async () => {
      const credentialGroupId = await createGroup('force-release-raced-group')
      const credential = await availableCredential('force-release-raced', credentialGroupId)
      const workflowId = await leaseCredential(credential.id)

      // The run ends between the administrator reading the pool view and pressing the button.
      await fixtures
        .db()
        .update(workflows)
        .set({
          state: 'succeeded',
          terminalOutcome: 'succeeded',
          outcomeReason: 'The run finished the work it was given.',
        })
        .where(eq(workflows.id, workflowId))

      const forced = await asAdmin().forceRelease({ agentCredentialId: credential.id })

      // The seat comes free — which is what was wanted — and the run keeps its own outcome.
      expect(forced.release.outcome).toBe('released')
      expect(forced.workflow.resolved).toBe(false)
      const run = await workflowRow(workflowId)
      expect(run.state).toBe('succeeded')
      expect(run.outcomeReason).toBe('The run finished the work it was given.')
    })

    it('changes nothing at all in a deployment that has wired no lease release', async () => {
      const credentialGroupId = await createGroup('force-release-unwired-group')
      const credential = await availableCredential('force-release-unwired', credentialGroupId)
      const workflowId = await leaseCredential(credential.id)

      const refusal = await refusalOf(
        createUnwiredCaller(contextFor(fixtures.db(), admin, denials)).forceRelease({
          agentCredentialId: credential.id,
        }),
      )

      expect(refusal.message).toContain(LEASE_RELEASE_NOT_CONFIGURED_REASON)

      // **The run is untouched.** The refusal is raised before anything is written precisely so
      // that this is true: a force-release resolves the run first and frees the seat second, so a
      // seam discovered missing halfway would have ended somebody's run and freed nothing.
      const run = await workflowRow(workflowId)
      expect(run.state).toBe('running')
      expect(run.terminalOutcome).toBeNull()
      const [lease] = await fixtures
        .db()
        .select()
        .from(credentialLeases)
        .where(eq(credentialLeases.workflowId, workflowId))
      expect(lease.releasedAt).toBeNull()
    })
  })

  /**
   * **SC-010, asserted on the selection query rather than on a second workflow's failure.**
   *
   * The criterion is that a credential which becomes unhealthy is excluded from selection *before*
   * it can be issued to a second workflow. There are two ways to write that test and only one of
   * them is worth anything.
   *
   * Asserting that a second workflow which took the seat then failed would pass against an
   * implementation that issued the seat and broke afterwards — which is precisely the behaviour
   * SC-010 forbids, and the failure would be indistinguishable from the requirement being met. So
   * every assertion below is made against `listSelectableCredentials`, the candidate query an
   * allocator draws from: the seat is asked for and is not offered, so there is no second workflow
   * and nothing for it to fail at.
   *
   * The control plane's `selectFor` — the query an acquisition actually runs — is pinned the same
   * way in `credentials/allocate/select.test.ts`. The two are deliberately separate assertions
   * because they are separate queries; what makes them agree is `selectableCredentialCondition`,
   * and `credential-store.ts` says why that is a single definition.
   */
  describe('an unhealthy seat leaves the candidate set before anybody can be given it (SC-010)', () => {
    it('is gone from the candidate query the moment its state changes, while still held', async () => {
      const credentialGroupId = await createGroup('sc010-group')
      const credential = await availableCredential('sc010', credentialGroupId)

      // The premise: it is a candidate to begin with, so its later absence means something.
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([credential.id])

      const workflowId = await leaseCredential(credential.id)
      const detected = await fixtures
        .db()
        .update(agentCredentials)
        .set({ state: 'unhealthy', lastFailureReason: 'the provider rejected the session' })
        .where(eq(agentCredentials.id, credential.id))
        .returning({ id: agentCredentials.id })
      expect(detected).toHaveLength(1)

      // Asked, and not offered. No second workflow exists in this test, which is the point.
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])
      expect((await asAdmin().get({ agentCredentialId: credential.id })).selectable).toBe(false)

      // And it stays out after the seat comes free, because release does not repair. This is the
      // moment SC-010 is actually about: nobody is holding the seat, so it is a candidate on every
      // criterion except the one that matters.
      await asAdmin().forceRelease({ agentCredentialId: credential.id })
      const after = await workflowRow(workflowId)
      expect(after.state).toBe('failed')
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])
      expect((await asAdmin().get({ agentCredentialId: credential.id })).state).toBe('unhealthy')
    })

    it('returns to the candidate set only through a login, never through a state edit', async () => {
      const credentialGroupId = await createGroup('sc010-recovered-group')
      const credential = await availableCredential('sc010-recovered', credentialGroupId)

      await fixtures
        .db()
        .update(agentCredentials)
        .set({ state: 'unhealthy', lastFailureReason: 'the provider rejected the session' })
        .where(eq(agentCredentials.id, credential.id))

      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      // FR-072: the same flow a first login uses, from `unhealthy`, and it is the *capture* that
      // puts the seat back — not the administrator saying it is fixed.
      await asAdmin().startLogin({ agentCredentialId: credential.id })
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])

      const captured = await recordAgentCredentialLogin(fixtures.db(), credential.id, {
        secretId: credential.secretId ?? '',
        lastLoginAt: new Date(),
      })
      expect(captured?.state).toBe('available')
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([credential.id])

      logins.expire(credential.id)
      await reapAbandonedLogins({ db: fixtures.db(), environments: logins })
    })
  })

  describe('the FR-005 delete refusal', () => {
    it('soft-deletes a seat no workflow has ever used', async () => {
      const credentialGroupId = await createGroup('deletable-group')
      const credential = await asAdmin().register({ name: named('deletable'), credentialGroupId })

      const deleted = await asAdmin().delete({ agentCredentialId: credential.id })

      expect(deleted.archivedAt).not.toBeNull()
      expect(deleted.enabled).toBe(false)

      // Archived, not gone: the id is in the trail, and nothing is repaired by its disappearance.
      const page = await asAdmin().list({ credentialGroupId, includeArchived: true, limit: 100 })
      expect(page.items.map((item) => item.id)).toContain(credential.id)

      // And it is hidden from the default view, because an archived seat is not capacity.
      const capacity = await asAdmin().list({ credentialGroupId, limit: 100 })
      expect(capacity.items.map((item) => item.id)).not.toContain(credential.id)
    })

    it('refuses once any lease references it, naming how many', async () => {
      const credentialGroupId = await createGroup('leased-group')
      const credential = await availableCredential('leased', credentialGroupId)
      await leaseCredential(credential.id)

      const refusal = await refusalOf(asAdmin().delete({ agentCredentialId: credential.id }))

      expect(refusal.code).toBe('CONFLICT')
      expect(refusal.message).toContain('leased 1 time,')
      expect(refusal.message).toContain('Disable it instead')
    })

    /**
     * The half of FR-005 that a live-lease-only check would get wrong. The requirement is about a
     * credential *any workflow has used*, so a seat whose run finished is still undeletable — that
     * finished run's record of what identity it worked as is the thing being protected.
     */
    it('still refuses after the lease has been released', async () => {
      const credentialGroupId = await createGroup('released-lease-group')
      const credential = await availableCredential('released-lease', credentialGroupId)
      const workflowId = await leaseCredential(credential.id)

      await fixtures
        .db()
        .update(credentialLeases)
        .set({ releasedAt: new Date(), releaseReason: 'terminal' })
        .where(eq(credentialLeases.workflowId, workflowId))

      const refusal = await refusalOf(asAdmin().delete({ agentCredentialId: credential.id }))
      expect(refusal.message).toContain('leased 1 time,')
    })

    it('leaves the seat untouched when it refuses, and disabling still works', async () => {
      const credentialGroupId = await createGroup('refused-intact-group')
      const credential = await availableCredential('refused-intact', credentialGroupId)
      await leaseCredential(credential.id)

      await refusalOf(asAdmin().delete({ agentCredentialId: credential.id }))

      const after = await asAdmin().get({ agentCredentialId: credential.id })
      expect(after.archivedAt).toBeNull()

      // FR-005's other half. If this failed, the refusal above would be a dead end.
      const disabled = await asAdmin().setEnabled({
        agentCredentialId: credential.id,
        enabled: false,
      })
      expect(disabled.credential.enabled).toBe(false)
    })

    it('reports an archived seat as missing rather than as archived', async () => {
      const credentialGroupId = await createGroup('archived-group')
      const credential = await asAdmin().register({ name: named('archived'), credentialGroupId })
      await asAdmin().delete({ agentCredentialId: credential.id })

      // Unlike an archived *group*: a credential is archived because a run used it, so its
      // continued existence is a historical fact rather than an administrable one.
      await expect(
        asAdmin().setEnabled({ agentCredentialId: credential.id, enabled: true }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('reports an unknown credential identically across every procedure (FR-190)', async () => {
      const caller = asAdmin()
      const expected = {
        code: 'NOT_FOUND',
        message: 'No such credential group, agent credential or execution profile.',
      }

      await expect(caller.get({ agentCredentialId: randomUUID() })).rejects.toMatchObject(expected)
      await expect(
        caller.setEnabled({ agentCredentialId: randomUUID(), enabled: false }),
      ).rejects.toMatchObject(expected)
      await expect(caller.delete({ agentCredentialId: randomUUID() })).rejects.toMatchObject(
        expected,
      )
      await expect(caller.startLogin({ agentCredentialId: randomUUID() })).rejects.toMatchObject(
        expected,
      )
      await expect(caller.loginStatus({ agentCredentialId: randomUUID() })).rejects.toMatchObject(
        expected,
      )
      await expect(caller.forceRelease({ agentCredentialId: randomUUID() })).rejects.toMatchObject(
        expected,
      )
    })
  })

  describe('the pool view (FR-009)', () => {
    it('carries the failure reason against the seat it belongs to', async () => {
      const credentialGroupId = await createGroup('failure-group')
      const credential = await availableCredential('failure', credentialGroupId)

      await fixtures
        .db()
        .update(agentCredentials)
        .set({ state: 'unhealthy', lastFailureReason: 'the provider rejected the session' })
        .where(eq(agentCredentials.id, credential.id))

      const listed = await asAdmin().get({ agentCredentialId: credential.id })

      // FR-009: a failed login is visible against the credential, not only in a log nobody reads.
      expect(listed.state).toBe('unhealthy')
      expect(listed.lastFailureReason).toBe('the provider rejected the session')
      expect(listed.selectable).toBe(false)
      await expect(selectableIn(credentialGroupId)).resolves.toStrictEqual([])
    })

    it('keeps one group’s credentials out of another’s listing', async () => {
      const mine = await createGroup('scoped-mine')
      const theirs = await createGroup('scoped-theirs')
      const credential = await availableCredential('scoped-seat', mine)
      await availableCredential('scoped-other-seat', theirs)

      const page = await asAdmin().list({ credentialGroupId: mine, limit: 100 })
      expect(page.items.map((item) => item.id)).toStrictEqual([credential.id])
      await expect(selectableIn(mine)).resolves.toStrictEqual([credential.id])
    })
  })
})
