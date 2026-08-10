import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from '../allocate/pool-fixtures'
import type { CredentialAlerter, UnhealthyCredentialAlert } from '../health'

import { createRefusingCredentialExerciser, exerciseCredential } from './exercise'
import { createFakeCredentialExerciser } from './exercise-fake'

/**
 * **T088 — one credential exercised: what it writes, and what it concludes.**
 *
 * Against a live database, because the claims are about rows. The one worth reading twice is the
 * `cooling_off` case: a provider limit **still updates `last_exercised_at`**, because the provider
 * answered and that is what a keep-alive was checking (FR-037). An authentication failure does not,
 * and the difference is the whole reason the two are separate states.
 */

const connectionString = readTestDatabaseUrl()

/** Pinned, so `last_exercised_at` can be asserted as an equality rather than as a range. */
const RAN_AT = new Date('2026-06-01T09:00:00.000Z')

const recordingAlerter = (): CredentialAlerter & {
  readonly alerts: UnhealthyCredentialAlert[]
} => {
  const alerts: UnhealthyCredentialAlert[] = []
  return {
    alerts,
    credentialUnhealthy: (alert) => {
      alerts.push(alert)
      return Promise.resolve()
    },
  }
}

describe.skipIf(connectionString === undefined)('exerciseCredential', () => {
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  let groupId = ''

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'exercise' })
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    await fixtures.execute('delete from keep_alive_runs')
    await fixtures.clearLeases()
    await fixtures.execute('delete from agent_credentials')
  })

  const seat = async (label: string, options?: { readonly secretId?: string | null }) =>
    fixtures.seedCredential({
      label,
      credentialGroupId: groupId,
      state: 'held',
      heldBy: 'keep_alive',
      lastExercisedAt: null,
      ...(options ?? {}),
    })

  it('records a successful exercise and moves the liveness clock (FR-035)', async () => {
    const credentialId = await seat('healthy')
    const exerciser = createFakeCredentialExerciser()

    const outcome = await exerciseCredential({
      db: fixtures.db(),
      exerciser,
      agentCredentialId: credentialId,
      now: RAN_AT,
    })

    expect(outcome).toMatchObject({ outcome: 'succeeded', credentialState: undefined })
    expect((await fixtures.credential(credentialId))?.lastExercisedAt).toStrictEqual(RAN_AT)

    const history = await fixtures.keepAliveRunsFor(credentialId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ outcome: 'succeeded', detail: null })
  })

  it('hands the exerciser the secret identifier and nothing else (FR-011, SC-014)', async () => {
    const credentialId = await seat('scoped')
    const exerciser = createFakeCredentialExerciser()

    await exerciseCredential({ db: fixtures.db(), exerciser, agentCredentialId: credentialId })

    // A name, never material. The implementation behind the seam fetches; this module never holds
    // anything a log or a return value could leak.
    expect(exerciser.requests[0]?.secretId).toContain('sisyphus/agent-credential/')
    expect(Object.keys(exerciser.requests[0] ?? {}).sort()).toStrictEqual([
      'agentCredentialId',
      'credentialName',
      'secretId',
    ])
  })

  it('leaves the seat where the caller put it: exercising does not release', async () => {
    // FR-038's other half. The claimant releases, in a `finally`, precisely because it has to
    // happen on paths this function never returns from.
    const credentialId = await seat('still-held')

    await exerciseCredential({
      db: fixtures.db(),
      exerciser: createFakeCredentialExerciser(),
      agentCredentialId: credentialId,
    })

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('held')
    expect(credential?.heldBy).toBe('keep_alive')
  })

  it('routes a provider limit to cooling off and raises nothing (FR-037, SC-019)', async () => {
    const credentialId = await seat('limited')
    const alerter = recordingAlerter()
    const exerciser = createFakeCredentialExerciser({
      otherwise: {
        outcome: 'refused',
        response: { status: 429, headers: { 'retry-after': '600' }, code: 'rate_limit_error' },
      },
    })

    const outcome = await exerciseCredential({
      db: fixtures.db(),
      exerciser,
      agentCredentialId: credentialId,
      alerter,
      now: RAN_AT,
    })

    expect(outcome).toMatchObject({
      outcome: 'cooling_off',
      credentialState: 'cooling_off',
      alerted: false,
    })
    expect(alerter.alerts).toStrictEqual([])

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('cooling_off')
    expect(credential?.coolingOffUntil).toStrictEqual(new Date('2026-06-01T09:10:00.000Z'))
    // The line worth reading twice: the provider answered, so the login is proven alive, which is
    // exactly what the keep-alive was checking (FR-037).
    expect(credential?.lastExercisedAt).toStrictEqual(RAN_AT)

    expect(await fixtures.keepAliveRunsFor(credentialId)).toMatchObject([
      { outcome: 'cooling_off' },
    ])
  })

  it('routes a broken login to unhealthy, alerts, and does not touch the liveness clock', async () => {
    const credentialId = await seat('broken')
    const alerter = recordingAlerter()
    const exerciser = createFakeCredentialExerciser({
      otherwise: { outcome: 'refused', response: { status: 401, body: 'invalid api key' } },
    })

    const outcome = await exerciseCredential({
      db: fixtures.db(),
      exerciser,
      agentCredentialId: credentialId,
      alerter,
      now: RAN_AT,
    })

    expect(outcome).toMatchObject({
      outcome: 'failed',
      credentialState: 'unhealthy',
      alerted: true,
    })
    expect(alerter.alerts).toHaveLength(1)

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('unhealthy')
    // Not proven alive. Recording it as recently exercised would keep the scheduler from ever
    // looking at it again, which is the wrong direction for a credential that needs a person.
    expect(credential?.lastExercisedAt).toBeNull()
    expect(credential?.lastFailureReason).toContain('authentication or authorisation failure')

    expect(await fixtures.keepAliveRunsFor(credentialId)).toMatchObject([{ outcome: 'failed' }])
  })

  it('records a refusal it cannot classify as cooling off rather than as a breakage (R5)', async () => {
    const credentialId = await seat('ambiguous')
    const exerciser = createFakeCredentialExerciser({
      otherwise: { outcome: 'refused', response: { status: 500, body: 'Internal server error' } },
    })

    const outcome = await exerciseCredential({
      db: fixtures.db(),
      exerciser,
      agentCredentialId: credentialId,
      now: RAN_AT,
    })

    expect(outcome).toMatchObject({ outcome: 'cooling_off' })
    // No stated time, so the FR-078 sweep retries it on the configured interval.
    expect((await fixtures.credential(credentialId))?.coolingOffUntil).toBeNull()
  })

  it('writes a detail that explains the outcome and quotes nothing from the provider', async () => {
    const echoed = 'sk-not-a-real-key-0000000000000000000000000000000000'
    const credentialId = await seat('quiet')
    const exerciser = createFakeCredentialExerciser({
      otherwise: {
        outcome: 'refused',
        response: { status: 401, body: `invalid api key ${echoed}` },
      },
    })

    await exerciseCredential({ db: fixtures.db(), exerciser, agentCredentialId: credentialId })

    // `keep_alive_runs.detail` is free text for an administrator, and free text is exactly where a
    // provider's echoed request header would end up if anything quoted a body.
    const history = await fixtures.keepAliveRunsFor(credentialId)
    expect(history[0]?.detail).not.toBeNull()
    expect(history[0]?.detail).not.toContain(echoed)
  })

  it('does not exercise a credential with nothing to fetch (FR-008)', async () => {
    const credentialId = await seat('no-material', { secretId: null })
    const exerciser = createFakeCredentialExerciser()

    const outcome = await exerciseCredential({
      db: fixtures.db(),
      exerciser,
      agentCredentialId: credentialId,
    })

    expect(outcome).toMatchObject({ outcome: 'not_exercisable' })
    expect(exerciser.exercised()).toStrictEqual([])
    // No history row: nothing was tried, and `failed` would be a lie about a login that has been
    // legitimately without material since it was registered.
    expect(await fixtures.keepAliveRunsFor(credentialId)).toHaveLength(0)
  })

  it('reports a credential that has gone rather than throwing', async () => {
    const outcome = await exerciseCredential({
      db: fixtures.db(),
      exerciser: createFakeCredentialExerciser(),
      agentCredentialId: '11111111-1111-4111-8111-111111111111',
    })

    expect(outcome).toMatchObject({ outcome: 'not_exercisable' })
  })

  it('lets a platform failure through rather than blaming the credential', async () => {
    const credentialId = await seat('unreachable')
    const exerciser = createFakeCredentialExerciser({
      throwsFor: { [credentialId]: new Error('Secrets Manager refused') },
    })

    await expect(
      exerciseCredential({ db: fixtures.db(), exerciser, agentCredentialId: credentialId }),
    ).rejects.toThrow('Secrets Manager refused')

    // Nothing recorded and nothing concluded. A throw is the platform being broken, and
    // classifying it would move a healthy credential to `cooling_off` for a configuration fault.
    expect(await fixtures.keepAliveRunsFor(credentialId)).toHaveLength(0)
    expect((await fixtures.credential(credentialId))?.state).toBe('held')
  })
})

describe('createRefusingCredentialExerciser', () => {
  it('refuses loudly rather than reporting a success nobody proved', async () => {
    // The same choice `createRefusingPromptRedactor` makes. A stub reporting success would mark
    // every seat in the pool as freshly exercised without reaching a provider — SC-009 defeated
    // silently and permanently, discovered when every login had already expired.
    const exerciser = createRefusingCredentialExerciser()

    await expect(
      exerciser.exercise({
        agentCredentialId: 'a',
        credentialName: 'pool-seat-1',
        secretId: 'sisyphus/agent-credential/a',
      }),
    ).rejects.toThrow('No credential exerciser is wired')
  })

  it('names the credential it could not keep alive', async () => {
    const exerciser = createRefusingCredentialExerciser()

    await expect(
      exerciser.exercise({ agentCredentialId: 'a', credentialName: 'pool-seat-1', secretId: 's' }),
    ).rejects.toThrow('pool-seat-1')
  })

  it('throws rather than returning a refusal, which would be classified', async () => {
    // The distinction the whole failure path turns on: a refusal is a provider's answer about the
    // credential, and this is the platform not being wired.
    const exerciser = createRefusingCredentialExerciser()
    const settled = await exerciser
      .exercise({ agentCredentialId: 'a', credentialName: 'n', secretId: 's' })
      .then(
        () => 'resolved',
        () => 'rejected',
      )

    expect(settled).toBe('rejected')
  })
})
