import { agentCredentials } from '@bluetel-ai/sisyphus-api/db'
import { ABANDONED_LOGIN_REASON } from '@bluetel-ai/sisyphus-api/server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { FakeComputeProvisioner } from '../../aws'
import { createFakeComputeProvisioner } from '../../aws'
import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from '../allocate/pool-fixtures'

import { DEFAULT_LOGIN_TTL_MS, provisionLoginEnvironment } from './environment'
import { REAP_LOGIN_ENVIRONMENTS_JOB_NAME, reapLoginEnvironments } from './reaper'

/**
 * The wall-clock reaper (T077, FR-071).
 *
 * ## How this is tested without waiting fifteen minutes
 *
 * Not with fake timers, and not by shortening the lifetime until the test is fast. Both would test
 * a different thing — the first tests the timer library, the second tests that a small number is
 * small. What is actually under test is that **the only input to the decision is a clock**, so the
 * clock is the injected value: the environment is provisioned at one instant and the sweep is run
 * with `now` set past its deadline. No time passes during the test at all.
 *
 * That is also why nothing here simulates a disconnect or a closed session. There is nothing to
 * simulate. Abandonment is the absence of every event, and the tests reproduce it by producing none.
 */

const connectionString = readTestDatabaseUrl()

const startedAt = new Date('2026-08-09T12:00:00.000Z')
const afterDeadline = new Date(startedAt.getTime() + DEFAULT_LOGIN_TTL_MS + 1)

describe.skipIf(connectionString === undefined)('reapLoginEnvironments', () => {
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(connectionString ?? '')

  let groupId: string

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'reaper' })
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  const awaitingLogin = async (label: string): Promise<string> =>
    fixtures.seedCredential({
      label,
      credentialGroupId: groupId,
      state: 'awaiting_login',
      secretId: null,
    })

  const provision = async (
    compute: FakeComputeProvisioner,
    agentCredentialId: string,
  ): Promise<string> =>
    (
      await provisionLoginEnvironment({
        compute,
        agentCredentialId,
        credentialName: 'seat',
        now: startedAt,
      })
    ).environmentId

  it('destroys an abandoned environment and records why against the seat', async () => {
    const compute = createFakeComputeProvisioner()
    const credentialId = await awaitingLogin('reaper-abandoned')
    const environmentId = await provision(compute, credentialId)

    // Nothing is reported. Nothing is closed. The clock moves past the deadline the launch wrote.
    const result = await reapLoginEnvironments({
      db: fixtures.db(),
      compute,
      now: afterDeadline,
    })

    expect(compute.terminations).toStrictEqual([environmentId])
    expect(result.reaped.map((reaped) => reaped.environmentId)).toStrictEqual([environmentId])
    expect(await compute.listLoginInstances()).toStrictEqual([])

    const credential = await fixtures.credential(credentialId)
    expect(credential?.lastFailureReason).toBe(ABANDONED_LOGIN_REASON)
    // The seat has not moved. An abandoned attempt leaves nothing behind but an explanation.
    expect(credential?.state).toBe('awaiting_login')
    expect(credential?.secretId).toBeNull()
    expect(credential?.lastLoginAt).toBeNull()
  })

  it('leaves an environment inside its deadline alone, however quiet it has been', async () => {
    const compute = createFakeComputeProvisioner()
    const credentialId = await awaitingLogin('reaper-live')
    await provision(compute, credentialId)

    // Somebody typing a password into a terminal is indistinguishable from somebody who has left,
    // right up until the deadline. That is the whole reason the deadline is what decides.
    const result = await reapLoginEnvironments({
      db: fixtures.db(),
      compute,
      now: new Date(startedAt.getTime() + DEFAULT_LOGIN_TTL_MS - 1),
    })

    expect(compute.terminations).toStrictEqual([])
    expect(result).toMatchObject({ considered: 1, reaped: [] })
    expect((await fixtures.credential(credentialId))?.lastFailureReason).toBeNull()
  })

  it('sweeps environments this process never started', async () => {
    const compute = createFakeComputeProvisioner()
    const credentialId = await awaitingLogin('reaper-orphan')

    // The panel process that started this login has been replaced, so the instance is the only
    // record of it. A reaper that remembered its own launches would never find this one.
    compute.seedLoginInstance({
      instanceId: 'i-login-orphan',
      agentCredentialId: credentialId,
      expiresAt: new Date(startedAt.getTime() + DEFAULT_LOGIN_TTL_MS),
      state: 'running',
    })

    await reapLoginEnvironments({ db: fixtures.db(), compute, now: afterDeadline })

    expect(compute.terminations).toStrictEqual(['i-login-orphan'])
    expect((await fixtures.credential(credentialId))?.lastFailureReason).toBe(
      ABANDONED_LOGIN_REASON,
    )
  })

  it('destroys an instance it cannot date, because nobody is accounting for it', async () => {
    const compute = createFakeComputeProvisioner()
    const credentialId = await awaitingLogin('reaper-undated')
    compute.seedLoginInstance({
      instanceId: 'i-login-undated',
      agentCredentialId: credentialId,
      expiresAt: undefined,
      state: 'running',
    })

    await reapLoginEnvironments({ db: fixtures.db(), compute, now: afterDeadline })

    expect(compute.terminations).toStrictEqual(['i-login-undated'])
  })

  it('destroys an instance it cannot attribute, without a seat to explain it against', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedLoginInstance({
      instanceId: 'i-login-nameless',
      agentCredentialId: undefined,
      expiresAt: new Date(startedAt.getTime() + DEFAULT_LOGIN_TTL_MS),
      state: 'running',
    })

    // Letting the bookkeeping half veto the expensive half would leave an interactive instance
    // running because there was nowhere to write a sentence about it.
    const result = await reapLoginEnvironments({
      db: fixtures.db(),
      compute,
      now: startedAt,
    })

    expect(result.unattributed).toStrictEqual(['i-login-nameless'])
    expect(compute.terminations).toStrictEqual(['i-login-nameless'])
  })

  it('never touches a workflow instance, whatever its age', async () => {
    const compute = createFakeComputeProvisioner()
    compute.seedInstance({
      instanceId: 'i-workflow-old',
      workflowId: 'workflow-1',
      state: 'running',
    })

    await reapLoginEnvironments({ db: fixtures.db(), compute, now: afterDeadline })

    // The two populations are disjoint at the seam (`aws/compute.ts`), so this reaper cannot see a
    // run's instance even when it has been running for a week. Terminating one would kill a job.
    expect(compute.terminations).toStrictEqual([])
    expect(await compute.listWorkflowInstances()).toHaveLength(1)
  })

  it('does not undo a login that landed a moment before the deadline', async () => {
    const compute = createFakeComputeProvisioner()
    const credentialId = await awaitingLogin('reaper-raced')
    await provision(compute, credentialId)

    // The capture won the race: material stored, seat available, environment destroyed by the
    // capture itself. What the reaper must not do is write an abandonment reason over it.
    await fixtures
      .db()
      .update(agentCredentials)
      .set({ state: 'available', secretId: 'arn:secret:raced', lastLoginAt: startedAt })
      .where(eq(agentCredentials.id, credentialId))
    await compute.terminate({
      instanceId: (await compute.listLoginInstances())[0]?.instanceId ?? '',
    })

    const result = await reapLoginEnvironments({
      db: fixtures.db(),
      compute,
      now: afterDeadline,
    })

    expect(result.reaped).toStrictEqual([])
    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('available')
    expect(credential?.lastFailureReason).toBeNull()
  })
})

describe('the reaper’s job name', () => {
  it('is stable, because a schedule and a log line both spell it', () => {
    expect(REAP_LOGIN_ENVIRONMENTS_JOB_NAME).toBe('reap-login-environments')
  })
})
