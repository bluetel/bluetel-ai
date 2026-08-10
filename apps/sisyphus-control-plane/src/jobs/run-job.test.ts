import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { selectFor } from '../credentials/allocate'
import type { CredentialPoolFixtures } from '../credentials/allocate/pool-fixtures'
import {
  createCredentialPoolFixtures,
  readTestDatabaseUrl,
} from '../credentials/allocate/pool-fixtures'
import {
  applyHealthVerdict,
  classifyProviderResponse,
  returnFromCoolingOff,
} from '../credentials/health'
import { acquireCredential } from '../credentials/lease'

import {
  CREDENTIAL_STATE_A_RUN_FAILS_ON,
  CREDENTIAL_STATE_A_RUN_WAITS_OUT,
  credentialFailedError,
  credentialFailureReason,
  credentialVerdictFor,
  runFailsForCredential,
  runJob,
  runWaitsForCredential,
  toError,
} from './run-job'

const fakeClock = (...ticks: number[]) => {
  let index = 0

  return () => {
    const tick = ticks[Math.min(index, ticks.length - 1)] ?? 0
    index += 1

    return tick
  }
}

describe('toError', () => {
  it('passes an Error through unchanged', () => {
    const original = new Error('boom')

    expect(toError(original)).toBe(original)
  })

  it('wraps a non-Error throw without losing its content', () => {
    expect(toError('not an error')).toBeInstanceOf(Error)
    expect(toError('not an error').message).toBe('not an error')
  })
})

describe('runJob', () => {
  it('reports the resolved value on success', async () => {
    const outcome = await runJob('reconcile', () => 42, fakeClock(1_000, 1_250))

    expect(outcome).toStrictEqual({
      ok: true,
      jobName: 'reconcile',
      durationMs: 250,
      value: 42,
    })
  })

  it('passes the job name through to the handler', async () => {
    const handler = vi.fn(() => 'done')

    await runJob('drain-queue', handler)

    expect(handler).toHaveBeenCalledWith({ jobName: 'drain-queue' })
  })

  it('awaits an async handler', async () => {
    const outcome = await runJob('start-workflow', () => Promise.resolve('started'))

    expect(outcome.ok && outcome.value).toBe('started')
  })

  it('captures a rejection instead of throwing', async () => {
    const failure = new Error('provisioning failed')

    const outcome = await runJob('start-workflow', () => Promise.reject(failure))

    expect(outcome).toStrictEqual({
      ok: false,
      jobName: 'start-workflow',
      durationMs: expect.any(Number) as number,
      error: failure,
    })
  })

  it('captures a synchronous throw', async () => {
    const outcome = await runJob('teardown-workflow', () => {
      throw new Error('lease still held')
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error.message).toBe('lease still held')
  })

  it('still reports a duration when the handler fails', async () => {
    const outcome = await runJob(
      'integration-tick',
      () => {
        throw new Error('nope')
      },
      fakeClock(500, 900),
    )

    expect(outcome.durationMs).toBe(400)
  })
})

/**
 * **T090 — a run whose own credential enters `cooling_off` waits rather than fails (FR-077,
 * SC-020), and keeps its seat while it waits (FR-023).**
 *
 * The predicate is pure, so the first half is a table. The second half runs against a live
 * database, because the load-bearing part of the requirement is not the decision — it is what the
 * run still holds while it waits. A run that "waited" with its seat handed back to the pool could
 * not be given its own credential again when the limit cleared, and FR-023 forbids giving it
 * anybody else's; the wait would have been a slower way of failing.
 */
describe('runWaitsForCredential (003/FR-077, SC-020)', () => {
  it('waits out a provider limit', () => {
    // The credential is alive and the provider is throttling. It clears by itself on the FR-076
    // sweep, usually in minutes, and SC-020 counts every run failed for one that later cleared.
    expect(runWaitsForCredential('cooling_off')).toBe(true)
    expect(CREDENTIAL_STATE_A_RUN_WAITS_OUT).toBe('cooling_off')
  })

  it('does not wait out anything else', () => {
    // `unhealthy` is the interesting exclusion: waiting does not repair a broken login, and FR-033
    // has that run fail *naming the credential* rather than sitting there. A different decision,
    // and it is `runFailsForCredential` below.
    for (const state of ['available', 'held', 'unhealthy', 'disabled', 'awaiting_login'] as const) {
      expect(runWaitsForCredential(state)).toBe(false)
    }
  })
})

/**
 * **T118 — a run whose own credential goes `unhealthy` is failed naming it, with no substitution
 * and no silent retry (003/FR-023, FR-033, SC-010).**
 *
 * The opposite decision to the one above, and the pair has to be read together: the two lists must
 * never overlap, and the whole file's worth of reasoning collapses if a state is both waited out
 * and failed for. So the decision table below quantifies over **every** member of
 * `credential_state` rather than over the interesting ones, and asserts the verdict is exactly one
 * of three.
 *
 * The live-database half is about what the run is *not*: not moved, not retried, not quietly given
 * somebody else's seat. Those are absences, and absences are only assertable against a real pool
 * that had a spare seat sitting in it — which is what the second credential in the group is for. A
 * suite whose group held one credential could not tell "did not substitute" from "had nothing to
 * substitute".
 */
describe('runFailsForCredential (003/FR-023, FR-033)', () => {
  it('fails a run whose credential has stopped working', () => {
    expect(runFailsForCredential('unhealthy')).toBe(true)
    expect(CREDENTIAL_STATE_A_RUN_FAILS_ON).toBe('unhealthy')
  })

  it('fails a run for nothing else, and never for the state a run waits out', () => {
    for (const state of [
      'available',
      'held',
      'cooling_off',
      'disabled',
      'awaiting_login',
    ] as const) {
      expect(runFailsForCredential(state)).toBe(false)
    }

    // The exclusivity, stated as itself. A credential the provider is throttling is alive and
    // clears by itself; failing a run for it is what SC-020 counts.
    expect(runFailsForCredential(CREDENTIAL_STATE_A_RUN_WAITS_OUT)).toBe(false)
    expect(runWaitsForCredential(CREDENTIAL_STATE_A_RUN_FAILS_ON)).toBe(false)
  })

  it('gives every state exactly one verdict, defaulting to proceed', () => {
    expect(credentialVerdictFor('cooling_off')).toBe('wait')
    expect(credentialVerdictFor('unhealthy')).toBe('fail')

    for (const state of ['available', 'held', 'disabled', 'awaiting_login'] as const) {
      expect(credentialVerdictFor(state)).toBe('proceed')
    }
  })
})

describe('what a run failed for its credential records (FR-033)', () => {
  it('names the credential, which is the requirement’s actual word', () => {
    const reason = credentialFailureReason({ name: 'vendor-seat-3', lastFailureReason: null })

    expect(reason).toContain('vendor-seat-3')
  })

  it('says the run was neither moved nor retried on another seat (FR-023)', () => {
    // The owner's first instinct is "so give it a different credential". The sentence answers that
    // with the rule rather than leaving them to ask for more capacity that would not have helped.
    const reason = credentialFailureReason({ name: 'vendor-seat-3', lastFailureReason: null })

    expect(reason).toContain('not moved to another agent credential')
    expect(reason).toContain('was not retried on one')
    expect(reason).toContain('single identity it was admitted with')
  })

  it('names the remedy as a re-login and a relaunch, not a retry', () => {
    const reason = credentialFailureReason({ name: 'vendor-seat-3', lastFailureReason: null })

    expect(reason).toContain('logged this credential back in')
    expect(reason).toMatch(/relaunch the run/i)
  })

  it('quotes the provider’s own words when the credential recorded any', () => {
    const reason = credentialFailureReason({
      name: 'vendor-seat-3',
      lastFailureReason: 'the provider rejected the session',
    })

    expect(reason).toContain('the provider rejected the session')
  })

  it('travels as an Error, so runJob captures it like every other job failure', async () => {
    const outcome = await runJob('start-workflow', () => {
      throw credentialFailedError({ name: 'vendor-seat-3', lastFailureReason: null })
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error.name).toBe('AgentCredentialUnusable')
    expect(!outcome.ok && outcome.error.message).toContain('vendor-seat-3')
  })
})

describe.skipIf(readTestDatabaseUrl() === undefined)(
  'a run waiting out its own credential’s limit',
  () => {
    const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(
      readTestDatabaseUrl() ?? '',
    )

    let groupId = ''
    let profileId = ''

    beforeAll(async () => {
      await fixtures.open()
      groupId = await fixtures.seedGroup({ label: 'waiting' })
      profileId = await fixtures.seedProfile({
        label: 'waiting',
        groups: [{ credentialGroupId: groupId, position: 1 }],
      })
    }, 120_000)

    afterAll(async () => {
      await fixtures.close()
    }, 120_000)

    it('keeps its lease, its identity and its non-terminal state (FR-023, SC-018)', async () => {
      const credentialId = await fixtures.seedCredential({
        label: 'limited',
        credentialGroupId: groupId,
      })
      const workflowId = await fixtures.seedWorkflow({
        label: 'limited',
        executionProfileId: profileId,
        state: 'running',
      })
      expect((await acquireCredential({ db: fixtures.db(), workflowId })).outcome).toBe('acquired')

      // The provider throttles the credential this run is authenticated as, mid-run.
      const transition = await applyHealthVerdict({
        db: fixtures.db(),
        agentCredentialId: credentialId,
        verdict: classifyProviderResponse({ status: 429, headers: { 'retry-after': '600' } }),
      })
      expect(transition).toMatchObject({ from: 'held', to: 'cooling_off' })

      const credential = await fixtures.credential(credentialId)
      expect(credential?.state).toBe('cooling_off')

      // The decision, taken on the state the row actually holds rather than on a literal.
      expect(runWaitsForCredential(credential?.state ?? 'available')).toBe(true)

      // And the three things that make the wait a wait rather than a slow failure. The seat is
      // still this run's: released, it would be taken by the next workflow in the queue and there
      // would be nothing to return to when the limit cleared — and FR-023 forbids substituting.
      const live = await fixtures.liveLeases()
      expect(live).toHaveLength(1)
      expect(live[0]).toMatchObject({ workflowId, agentCredentialId: credentialId })
      expect(live[0]?.releasedAt).toBeNull()
      expect(credential?.heldBy).toBe('workflow')

      // The run is untouched: not failed, and still naming the one identity it used (FR-059).
      const rows = await fixtures.db().execute<{
        state: string
        agent_credential_id: string | null
        terminal_outcome: string | null
      }>(sql`select state, agent_credential_id, terminal_outcome from workflows where id = ${workflowId}`)
      expect([...rows][0]).toStrictEqual({
        state: 'running',
        agent_credential_id: credentialId,
        terminal_outcome: null,
      })
    })

    it('carries on with its own credential when the limit clears (SC-020)', async () => {
      // The other end of the same requirement: the FR-076 sweep returns the seat, and returns it to
      // the run that never let go of it. Nothing re-acquires and nothing is substituted.
      const credentialId = await fixtures.seedCredential({
        label: 'cleared',
        credentialGroupId: groupId,
      })
      const workflowId = await fixtures.seedWorkflow({
        label: 'cleared',
        executionProfileId: profileId,
        state: 'running',
      })
      await acquireCredential({ db: fixtures.db(), workflowId })

      await applyHealthVerdict({
        db: fixtures.db(),
        agentCredentialId: credentialId,
        verdict: classifyProviderResponse({ status: 429 }),
      })
      const returned = await returnFromCoolingOff({
        db: fixtures.db(),
        agentCredentialId: credentialId,
        reason: 'the retry interval had elapsed',
      })

      // Back to `held`, not to the pool: the run is still on this seat.
      expect(returned).toMatchObject({ outcome: 'changed', to: 'held' })
      const credential = await fixtures.credential(credentialId)
      expect(runWaitsForCredential(credential?.state ?? 'cooling_off')).toBe(false)

      // One lease against this credential, never released and never re-taken: one workflow, one
      // identity, end to end (SC-018).
      const leases = (await fixtures.leases()).filter(
        (lease) => lease.agentCredentialId === credentialId,
      )
      expect(leases).toHaveLength(1)
      expect(leases[0]?.releasedAt).toBeNull()
      expect(leases[0]?.workflowId).toBe(workflowId)
    })
  },
)

describe.skipIf(readTestDatabaseUrl() === undefined)(
  'a run failed for its own credential (T118, FR-023, FR-033)',
  () => {
    const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(
      readTestDatabaseUrl() ?? '',
    )

    let groupId = ''
    let profileId = ''
    /**
     * A second, perfectly good seat in the same group — the whole point of the fixture.
     *
     * "The run was not substituted" is an absence, and an absence is only evidence when there was
     * something to substitute. With one credential in the group, a platform that tried to move the
     * run and failed would look identical to one that never tried.
     */
    let spareCredentialId = ''

    beforeAll(async () => {
      await fixtures.open()
      groupId = await fixtures.seedGroup({ label: 'broken' })
      profileId = await fixtures.seedProfile({
        label: 'broken',
        groups: [{ credentialGroupId: groupId, position: 1 }],
      })
      spareCredentialId = await fixtures.seedCredential({
        label: 'broken-spare',
        credentialGroupId: groupId,
        // Used more recently than the seat the run takes, so least-recently-used gives the run the
        // other one — and leaves this one as the seat a substitution would reach for the moment the
        // run's own credential stops being a candidate.
        lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    }, 120_000)

    afterAll(async () => {
      await fixtures.close()
    }, 120_000)

    it('is failed naming the credential, and moved to no other seat (FR-023, FR-033)', async () => {
      const credentialId = await fixtures.seedCredential({
        label: 'broken-held',
        credentialGroupId: groupId,
        lastUsedAt: new Date('2020-01-01T00:00:00.000Z'),
      })
      const workflowId = await fixtures.seedWorkflow({
        label: 'broken-run',
        executionProfileId: profileId,
        state: 'running',
      })
      const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
      expect(acquired).toMatchObject({ outcome: 'acquired', agentCredentialId: credentialId })

      // The provider rejects the session mid-run: the login is broken, not throttled (FR-075).
      const transition = await applyHealthVerdict({
        db: fixtures.db(),
        agentCredentialId: credentialId,
        verdict: classifyProviderResponse({ status: 401 }),
      })
      expect(transition).toMatchObject({ from: 'held', to: 'unhealthy' })

      const credential = await fixtures.credential(credentialId)
      expect(credential?.state).toBe('unhealthy')

      // The decision, taken on the state the row actually holds rather than on a literal — and it
      // is `fail`, not `wait`: nothing about waiting repairs a broken login.
      expect(credentialVerdictFor(credential?.state ?? 'available')).toBe('fail')

      // Naming it, which is FR-033's actual word, and quoting what the credential recorded.
      const reason = credentialFailureReason({
        name: credential?.name ?? '',
        lastFailureReason: credential?.lastFailureReason ?? null,
      })
      expect(reason).toContain(credential?.name ?? '')
      expect(reason).toContain(credential?.lastFailureReason ?? '')

      // **No substitution.** The run holds exactly one lease, against the broken seat, and the
      // spare in the same group has never been leased by anybody.
      const live = await fixtures.liveLeases()
      expect(live.filter((lease) => lease.workflowId === workflowId)).toHaveLength(1)
      expect(live.filter((lease) => lease.workflowId === workflowId)[0]?.agentCredentialId).toBe(
        credentialId,
      )
      const spare = await fixtures.credential(spareCredentialId)
      expect(spare?.state).toBe('available')
      expect(spare?.heldBy).toBeNull()
      expect((await fixtures.leases()).map((lease) => lease.agentCredentialId)).not.toContain(
        spareCredentialId,
      )

      // **And no silent retry.** A run whose seat broke is not re-admitted onto the spare: the
      // exclusivity index (FR-015) refuses a second live lease for the same workflow, so an
      // acquisition attempted here reports the seat it already has rather than granting a new one.
      // That is what makes "no substitution" a property of the pool rather than of nobody trying.
      const retried = await acquireCredential({ db: fixtures.db(), workflowId })
      expect(retried).toMatchObject({ outcome: 'already_held', agentCredentialId: credentialId })
      expect(await fixtures.liveLeases()).toHaveLength(1)

      // The seat is left where it is: a health transition does not touch the lease, and the release
      // happens when the run reaches its terminal state like any other (FR-018, FR-019).
      expect(live[0]?.releasedAt).toBeNull()

      // FR-059 survives: the run's record still names the one identity it worked as.
      const rows = await fixtures.db().execute<{
        agent_credential_id: string | null
      }>(sql`select agent_credential_id from workflows where id = ${workflowId}`)
      expect([...rows][0]?.agent_credential_id).toBe(credentialId)
    }, 30_000)

    it('takes the broken seat out of the candidate set, so no second run is given it (SC-010)', async () => {
      // The other half of the same event, and the reason failing this run is not merely a policy
      // about one workflow: an `unhealthy` seat leaves selection at the moment it is marked, so
      // there is no second run to fail for the same credential.
      const credentialId = await fixtures.seedCredential({
        label: 'broken-excluded',
        credentialGroupId: groupId,
        lastUsedAt: new Date('2019-01-01T00:00:00.000Z'),
      })

      await applyHealthVerdict({
        db: fixtures.db(),
        agentCredentialId: credentialId,
        verdict: classifyProviderResponse({ status: 403 }),
      })

      const other = await fixtures.seedWorkflow({
        label: 'broken-excluded-run',
        executionProfileId: profileId,
        state: 'queued',
      })
      const selected = await selectFor(fixtures.db(), { workflowId: other })

      expect(selected?.agentCredentialId).not.toBe(credentialId)
    }, 30_000)
  },
)
