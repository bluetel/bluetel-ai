import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialPoolFixtures } from '../allocate/pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from '../allocate/pool-fixtures'
import { acquireCredential } from '../lease'

import type { HealthVerdict } from './classify'
import { classifyProviderResponse } from './classify'
import type { CredentialAlerter, UnhealthyCredentialAlert } from './transition'
import { applyHealthVerdict, returnFromCoolingOff } from './transition'

/**
 * **T085 — applying a verdict to the row, and who gets told.**
 *
 * Against a live database, because every claim here is a claim about what a transaction wrote: the
 * state, the return time, the audit entry, and — the one that is easiest to get wrong and hardest
 * to notice — what was *not* touched. A run's lease surviving its credential going `cooling_off` is
 * the difference between FR-077 (wait it out) and a silent substitution FR-023 forbids, and it is
 * only observable against real rows.
 *
 * The alerter is a spy rather than a fake module, because the assertion is about **how many times
 * it was called**, and on which branch. SC-019 is stated as an absence — a credential that hits a
 * limit "generates no alert" — and an absence is only provable by counting.
 */

const connectionString = readTestDatabaseUrl()

/** A verdict as the classifier would produce it, so the two halves cannot drift apart in a test. */
const limitVerdict = (until?: Date): HealthVerdict =>
  classifyProviderResponse(
    until === undefined
      ? { status: 429, body: 'usage limit reached' }
      : { status: 429, headers: { 'retry-after': String((until.getTime() - Date.now()) / 1000) } },
  )

const brokenVerdict = (): HealthVerdict =>
  classifyProviderResponse({ status: 401, code: 'authentication_error', body: 'invalid api key' })

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

describe.skipIf(connectionString === undefined)('applyHealthVerdict', () => {
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  let groupId = ''
  let profileId = ''

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'health' })
    profileId = await fixtures.seedProfile({
      label: 'health',
      groups: [{ credentialGroupId: groupId, position: 1 }],
    })
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    await fixtures.clearLeases()
  })

  it('moves an available credential to cooling off with the provider’s return time (FR-078)', async () => {
    const until = new Date(Date.now() + 900_000)
    const credentialId = await fixtures.seedCredential({
      label: 'cooler',
      credentialGroupId: groupId,
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(until),
    })

    expect(outcome).toMatchObject({ outcome: 'changed', from: 'available', to: 'cooling_off' })

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('cooling_off')
    expect(credential?.coolingOffUntil).not.toBeNull()
    expect(credential?.lastFailureReason).toContain('usage or rate limit')
  })

  it('leaves cooling_off_until null when the provider named no time (FR-078)', async () => {
    // The case the sweep's retry interval exists for. A guessed deadline here would be shown to an
    // administrator as an expected return time, which would be an invention on a screen.
    const credentialId = await fixtures.seedCredential({
      label: 'timeless',
      credentialGroupId: groupId,
    })

    await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(),
    })

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('cooling_off')
    expect(credential?.coolingOffUntil).toBeNull()
  })

  it('raises nothing at all when a credential cools off (FR-076, SC-019)', async () => {
    const alerter = recordingAlerter()
    const credentialId = await fixtures.seedCredential({
      label: 'quiet',
      credentialGroupId: groupId,
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(),
      alerter,
    })

    // The requirement is an absence, so it is asserted as a count. A provider limit that paged
    // somebody would train them to ignore the channel that carries the breakages.
    expect(alerter.alerts).toStrictEqual([])
    expect(outcome).toMatchObject({ alerted: false, alertError: undefined })
  })

  it('alerts an administrator when a credential becomes unhealthy (FR-037, FR-056)', async () => {
    const alerter = recordingAlerter()
    const credentialId = await fixtures.seedCredential({
      label: 'broken',
      credentialGroupId: groupId,
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: brokenVerdict(),
      alerter,
    })

    expect(outcome).toMatchObject({ to: 'unhealthy', alerted: true })
    expect(alerter.alerts).toHaveLength(1)
    expect(alerter.alerts[0]).toMatchObject({
      agentCredentialId: credentialId,
      previousState: 'available',
    })
    // The name, so the alert says which seat without the reader having to look one up.
    expect(alerter.alerts[0]?.credentialName).toContain('broken')
  })

  it('transitions even with no alerter wired, because the row must not depend on Slack', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'unwired',
      credentialGroupId: groupId,
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: brokenVerdict(),
    })

    expect(outcome).toMatchObject({ to: 'unhealthy', alerted: false })
    expect((await fixtures.credential(credentialId))?.state).toBe('unhealthy')
  })

  it('reports an alert it could not hand off rather than failing the transition', async () => {
    const failing: CredentialAlerter = {
      credentialUnhealthy: () => Promise.reject(new Error('Slack is unreachable')),
    }
    const credentialId = await fixtures.seedCredential({
      label: 'unheard',
      credentialGroupId: groupId,
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: brokenVerdict(),
      alerter: failing,
    })

    // The credential really is broken and really is out of the pool. Turning an unreachable
    // messenger into a failed transition would leave the row saying the credential was fine.
    expect((await fixtures.credential(credentialId))?.state).toBe('unhealthy')
    expect(outcome).toMatchObject({ outcome: 'changed', alerted: false })
    expect(outcome.outcome === 'changed' && outcome.alertError?.message).toBe(
      'Slack is unreachable',
    )
  })

  it('writes one state_changed entry naming both states (FR-058)', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'audited',
      credentialGroupId: groupId,
    })

    await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(),
    })

    const entries = await fixtures.auditFor(credentialId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entityType: 'agent_credential',
      entityId: credentialId,
      action: 'state_changed',
      // Null actor: the provider decided this, not an administrator.
      actorUserId: null,
      detail: { from: 'available', to: 'cooling_off' },
    })
  })

  it('keeps the run’s lease when its own credential cools off mid-run (FR-023, FR-077)', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'mid-run',
      credentialGroupId: groupId,
    })
    const workflowId = await fixtures.seedWorkflow({
      label: 'mid-run',
      executionProfileId: profileId,
    })
    const acquired = await acquireCredential({ db: fixtures.db(), workflowId })
    expect(acquired.outcome).toBe('acquired')

    await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(),
    })

    // The seat is the run's for the whole of its life (FR-018, FR-019). A health transition that
    // released it would be a substitution by the back door, which FR-023 forbids outright.
    const live = await fixtures.liveLeases()
    expect(live).toHaveLength(1)
    expect(live[0]?.agentCredentialId).toBe(credentialId)

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('cooling_off')
    // `held_by` is untouched: the run is still on this seat, and the pool view has to say so.
    expect(credential?.heldBy).toBe('workflow')
    expect(credential?.fence).toBe(acquired.outcome === 'acquired' ? acquired.fence : -1)
  })

  it('does not relabel a credential an administrator has disabled (FR-006)', async () => {
    const alerter = recordingAlerter()
    const credentialId = await fixtures.seedCredential({
      label: 'withheld',
      credentialGroupId: groupId,
      state: 'disabled',
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: brokenVerdict(),
      alerter,
    })

    expect(outcome).toStrictEqual({
      outcome: 'unchanged',
      agentCredentialId: credentialId,
      state: 'disabled',
    })
    expect((await fixtures.credential(credentialId))?.state).toBe('disabled')
    expect(await fixtures.auditFor(credentialId)).toHaveLength(0)
    expect(alerter.alerts).toStrictEqual([])
  })

  it('does not let a cooling-off verdict repair a credential that needs a person', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'still-broken',
      credentialGroupId: groupId,
      state: 'unhealthy',
    })

    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(),
    })

    // Allowing it would put a broken login back in the pool on the next FR-076 sweep, with the
    // breakage intact and nobody told.
    expect(outcome).toMatchObject({ outcome: 'unchanged', state: 'unhealthy' })
  })

  it('refreshes the deadline when a waiting run hits the same limit again (FR-077)', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'again',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: null,
    })

    const later = new Date(Date.now() + 1_800_000)
    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      verdict: limitVerdict(later),
    })

    expect(outcome).toMatchObject({ from: 'cooling_off', to: 'cooling_off' })
    expect((await fixtures.credential(credentialId))?.coolingOffUntil).not.toBeNull()
  })

  it('reports a credential that is not there rather than throwing', async () => {
    const outcome = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: '11111111-1111-4111-8111-111111111111',
      verdict: limitVerdict(),
    })

    expect(outcome).toStrictEqual({
      outcome: 'unchanged',
      agentCredentialId: '11111111-1111-4111-8111-111111111111',
      state: undefined,
    })
  })
})

describe.skipIf(connectionString === undefined)('returnFromCoolingOff', () => {
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  let groupId = ''

  beforeAll(async () => {
    await fixtures.open()
    groupId = await fixtures.seedGroup({ label: 'return' })
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    await fixtures.clearLeases()
  })

  it('returns the seat to the pool and clears what it was waiting on (FR-076)', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'back',
      credentialGroupId: groupId,
      state: 'cooling_off',
      coolingOffUntil: new Date(Date.now() - 60_000),
      lastFailureReason: 'the provider refused with status 429',
    })

    const outcome = await returnFromCoolingOff({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      reason: 'the stated limit had passed',
    })

    expect(outcome).toMatchObject({ outcome: 'changed', from: 'cooling_off', to: 'available' })

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('available')
    expect(credential?.coolingOffUntil).toBeNull()
    // The reason described a limit that has now cleared. Left in place it would show "rate limited"
    // against an available seat, which is a screen contradicting itself.
    expect(credential?.lastFailureReason).toBeNull()
  })

  it('returns a seat a run is still on to `held`, not to the pool (FR-023, SC-003)', async () => {
    // The worst bug available in this module, asserted rather than described. A run that waited out
    // its limit still holds this credential; a sweep that put it back to `available` would have the
    // row say free while a live lease named it, and selection would hand one agent identity to a
    // second workflow while the first was still authenticated as it.
    const credentialId = await fixtures.seedCredential({
      label: 'still-on-it',
      credentialGroupId: groupId,
      state: 'cooling_off',
      heldBy: 'workflow',
      coolingOffUntil: new Date(Date.now() - 60_000),
    })

    const outcome = await returnFromCoolingOff({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      reason: 'the stated limit had passed',
    })

    expect(outcome).toMatchObject({ outcome: 'changed', from: 'cooling_off', to: 'held' })

    const credential = await fixtures.credential(credentialId)
    expect(credential?.state).toBe('held')
    expect(credential?.heldBy).toBe('workflow')
    expect(credential?.coolingOffUntil).toBeNull()
  })

  it('returns a seat a keep-alive is still on to `held` too', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'still-exercising',
      credentialGroupId: groupId,
      state: 'cooling_off',
      heldBy: 'keep_alive',
    })

    await returnFromCoolingOff({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      reason: 'the retry interval had elapsed',
    })

    // The keep-alive's own release is what hands it back, and it is conditional on `held_by` — so
    // the two mechanisms hand off cleanly rather than each undoing the other.
    expect((await fixtures.credential(credentialId))?.state).toBe('held')
  })

  it('records the return as a state change too (FR-058)', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'trailed',
      credentialGroupId: groupId,
      state: 'cooling_off',
    })

    await returnFromCoolingOff({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      reason: 'the retry interval had elapsed',
    })

    expect(await fixtures.auditFor(credentialId)).toMatchObject([
      { action: 'state_changed', detail: { from: 'cooling_off', to: 'available' } },
    ])
  })

  it('leaves a credential that has moved on since the sweep read it', async () => {
    const credentialId = await fixtures.seedCredential({
      label: 'moved',
      credentialGroupId: groupId,
      state: 'cooling_off',
    })
    await fixtures
      .db()
      .execute(sql`update agent_credentials set state = 'disabled' where id = ${credentialId}`)

    const outcome = await returnFromCoolingOff({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      reason: 'the retry interval had elapsed',
    })

    expect(outcome).toStrictEqual({
      outcome: 'unchanged',
      agentCredentialId: credentialId,
      state: 'disabled',
    })
    expect(await fixtures.auditFor(credentialId)).toHaveLength(0)
  })

  it('never raises anything, in either direction (SC-019)', async () => {
    // There is no alerter parameter to pass, and that is the assertion. The shape of the function
    // is what makes "returns to service without any administrator action, and generates no alert"
    // true, rather than every caller remembering not to pass one — an option that existed would
    // eventually be wired "just for visibility", which is how the channel fills with self-resolving
    // events and stops being read.
    const credentialId = await fixtures.seedCredential({
      label: 'silent',
      credentialGroupId: groupId,
      state: 'cooling_off',
    })

    const outcome = await returnFromCoolingOff({
      db: fixtures.db(),
      agentCredentialId: credentialId,
      reason: 'the retry interval had elapsed',
    })

    expect(outcome).toMatchObject({ outcome: 'changed', alerted: false, alertError: undefined })
  })
})
