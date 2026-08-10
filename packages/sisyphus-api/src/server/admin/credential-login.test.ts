import { describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'

import type { AgentCredentialLoginEnvironments, LoginEnvironment } from './credential-login'
import {
  ABANDONED_LOGIN_REASON,
  createRefusingLoginEnvironments,
  LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON,
  reapAbandonedLogins,
} from './credential-login'

/**
 * The login environment port and the wall-clock sweep over it (T077, FR-069..FR-072).
 *
 * The sweep's database writes are exercised against a live database in `credentials.test.ts`,
 * where a registered credential actually exists to write a reason against. What is proved here is
 * the *decision*: which environments a given clock destroys, in what order the two effects happen,
 * and that nothing in the port's vocabulary can carry credential material. Those are properties of
 * the function rather than of Postgres, and pinning them here means they hold on a laptop with no
 * database as well as in CI.
 */

const environmentAt = (
  environmentId: string,
  agentCredentialId: string,
  expiresAt: string,
): LoginEnvironment => ({
  environmentId,
  agentCredentialId,
  startedAt: new Date('2026-08-09T12:00:00.000Z'),
  expiresAt: new Date(expiresAt),
})

/** Records what the sweep did, and in which order it did it. */
interface RecordingEnvironments extends AgentCredentialLoginEnvironments {
  readonly destroyed: readonly string[]
}

const recordingEnvironments = (live: readonly LoginEnvironment[]): RecordingEnvironments => {
  const destroyed: string[] = []

  return {
    destroyed,
    start: () => Promise.reject(new Error('not used by the sweep')),
    find: () => Promise.resolve(undefined),
    list: () => Promise.resolve(live),
    destroy: (input) => {
      destroyed.push(input.environmentId)
      return Promise.resolve()
    },
  }
}

/**
 * The narrowest possible stand-in for the handle the sweep writes through.
 *
 * `reapAbandonedLogins` performs exactly one statement per reap — `update … set … where … returning`
 * — so a recorder of that chain is enough to assert both what was written and how many rows it
 * claimed to touch, without a database or a Drizzle mock that would only restate the query builder.
 */
const recordingDatabase = (rowsAffected = 1) => {
  const updates: { readonly values: unknown }[] = []

  const db = {
    update: () => ({
      set: (values: unknown) => ({
        where: () => ({
          returning: () => {
            updates.push({ values })
            return Promise.resolve(Array.from({ length: rowsAffected }, () => ({ id: 'row' })))
          },
        }),
      }),
    }),
  } as unknown as SisyphusDatabase

  return { db, updates }
}

describe('the login environment the platform wires when a deployment wires none', () => {
  it('refuses to start one, naming the missing configuration', async () => {
    // An unwired deployment that appeared to start a login would leave an administrator waiting at
    // a terminal that never opens, with nothing against the credential to say why.
    await expect(
      createRefusingLoginEnvironments().start({
        agentCredentialId: 'credential-1',
        credentialName: 'seat-one',
      }),
    ).rejects.toThrow(LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON)
  })

  it('answers the sweep honestly rather than failing it', async () => {
    const refusing = createRefusingLoginEnvironments()

    // A deployment with no provisioner has no environments, so "none" is true and not a guess. A
    // reaper that threw here would fail on every schedule while having nothing at all to do.
    await expect(refusing.list()).resolves.toStrictEqual([])
    await expect(refusing.find('credential-1')).resolves.toBeUndefined()
    await expect(refusing.destroy({ environmentId: 'i-login' })).resolves.toBeUndefined()
  })
})

describe('reapAbandonedLogins', () => {
  it('destroys an environment whose deadline has passed and records why against the seat', async () => {
    const environments = recordingEnvironments([
      environmentAt('i-login-1', 'credential-1', '2026-08-09T12:15:00.000Z'),
    ])
    const { db, updates } = recordingDatabase()

    const result = await reapAbandonedLogins({
      db,
      environments,
      now: new Date('2026-08-09T12:15:01.000Z'),
    })

    expect(environments.destroyed).toStrictEqual(['i-login-1'])
    expect(result.reaped).toStrictEqual([
      {
        environmentId: 'i-login-1',
        agentCredentialId: 'credential-1',
        expiresAt: new Date('2026-08-09T12:15:00.000Z'),
        reasonRecorded: true,
      },
    ])
    expect(updates).toHaveLength(1)
    expect(updates[0]?.values).toMatchObject({ lastFailureReason: ABANDONED_LOGIN_REASON })
  })

  /**
   * **The assertion the abandoned case turns on.** Nothing is passed to this function that says
   * whether the administrator is still there: no session, no heartbeat, no completion event. The
   * only input that decides anything is the clock, which is exactly why the tab-closed case is
   * reachable at all.
   */
  it('leaves an environment inside its deadline alone, however quiet it has been', async () => {
    const environments = recordingEnvironments([
      environmentAt('i-login-1', 'credential-1', '2026-08-09T12:15:00.000Z'),
    ])
    const { db, updates } = recordingDatabase()

    const result = await reapAbandonedLogins({
      db,
      environments,
      now: new Date('2026-08-09T12:14:59.000Z'),
    })

    expect(environments.destroyed).toStrictEqual([])
    expect(result).toStrictEqual({ considered: 1, reaped: [] })
    expect(updates).toStrictEqual([])
  })

  it('reaps on the deadline itself, not one tick after it', async () => {
    const environments = recordingEnvironments([
      environmentAt('i-login-1', 'credential-1', '2026-08-09T12:15:00.000Z'),
    ])
    const { db } = recordingDatabase()

    await reapAbandonedLogins({
      db,
      environments,
      now: new Date('2026-08-09T12:15:00.000Z'),
    })

    expect(environments.destroyed).toStrictEqual(['i-login-1'])
  })

  it('sweeps every expired environment rather than stopping at the first', async () => {
    const environments = recordingEnvironments([
      environmentAt('i-login-1', 'credential-1', '2026-08-09T12:15:00.000Z'),
      environmentAt('i-login-2', 'credential-2', '2026-08-09T12:40:00.000Z'),
      environmentAt('i-login-3', 'credential-3', '2026-08-09T12:20:00.000Z'),
    ])
    const { db } = recordingDatabase()

    const result = await reapAbandonedLogins({
      db,
      environments,
      now: new Date('2026-08-09T12:30:00.000Z'),
    })

    expect(environments.destroyed).toStrictEqual(['i-login-1', 'i-login-3'])
    expect(result.considered).toBe(3)
  })

  it('reports a reason it could not write without pretending the instance survived', async () => {
    const environments = recordingEnvironments([
      environmentAt('i-login-1', 'credential-gone', '2026-08-09T12:15:00.000Z'),
    ])
    const { db } = recordingDatabase(0)

    const result = await reapAbandonedLogins({
      db,
      environments,
      now: new Date('2026-08-09T13:00:00.000Z'),
    })

    // The credential row is gone — archived and hard-deleted in some later cleanup, or never there.
    // The instance is still destroyed, because the instance is the thing costing money.
    expect(environments.destroyed).toStrictEqual(['i-login-1'])
    expect(result.reaped[0]?.reasonRecorded).toBe(false)
  })

  it('leaves a reason a person can act on, with nothing value-shaped in it', () => {
    // FR-009 and FR-070 in one place: `last_failure_reason` is rendered to administrators verbatim,
    // so it has to say what happened *and* what to do — and it is a fixed sentence rather than a
    // rendering of anything the environment held. Asserted against the shape a credential takes
    // rather than against the word "material", which the sentence legitimately uses to explain
    // that none was captured.
    expect(ABANDONED_LOGIN_REASON).toContain('Nothing was recorded against this credential')
    expect(ABANDONED_LOGIN_REASON).toContain('Start the login again')
    expect(ABANDONED_LOGIN_REASON).not.toMatch(/[A-Za-z0-9_-]{32,}/)
    expect(ABANDONED_LOGIN_REASON).not.toMatch(/\bsk-|\bghp_|Bearer /)
  })
})
