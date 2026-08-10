import { workflowEvents } from '@bluetel-ai/sisyphus-api/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { WaitReason } from '../credentials/allocate'
import {
  createCredentialPoolFixtures,
  readTestDatabaseUrl,
} from '../credentials/allocate/pool-fixtures'

import {
  CREDENTIAL_WAIT_EVENT,
  credentialWaitDetailFor,
  latestCredentialWait,
  recordCredentialWait,
} from './credential-wait'

/**
 * A wait is recorded on the timeline as a `queued` entry with a discriminator, and everything here
 * is about the two ways that could go wrong: writing something the reader cannot parse, and reading
 * an entry that means something else.
 *
 * The second is the one that would be silent. `queued` already means "waiting under the FR-040
 * concurrency ceiling", and a query that matched the event name alone would time a credential wait
 * from the moment the run was created — so a run that had waited four seconds for a seat would be
 * failed by FR-028's limit for having waited an hour for a machine.
 */

const connectionString = readTestDatabaseUrl()

const reason: WaitReason = {
  kind: 'all_held',
  configurationFault: false,
  grantable: true,
  groups: [
    { credentialGroupId: 'group-1', name: 'shared-seats', position: 1, usable: true },
    { credentialGroupId: 'group-2', name: 'overflow', position: 2, usable: false },
  ],
  census: { available: 0, held: 2, coolingOff: 0, unavailable: 0, total: 2 },
  summary: 'Every agent credential this run can reach is held by another run.',
  remedy: 'Wait for a run to finish, or register more credentials in these groups.',
}

describe('what a wait records', () => {
  it('carries the classification, the sentences and the groups in order', () => {
    expect(credentialWaitDetailFor(reason)).toStrictEqual({
      waitingOn: 'agent_credential',
      kind: 'all_held',
      configurationFault: false,
      groups: [
        { name: 'shared-seats', position: 1 },
        { name: 'overflow', position: 2 },
      ],
      summary: reason.summary,
      remedy: reason.remedy,
    })
  })

  it('does not carry the census', () => {
    // A point-in-time count is stale the moment it is written, and a panel rendering "3 held"
    // against a pool that has since changed would be confidently wrong. The sentences say what was
    // true without inviting arithmetic on it.
    expect(Object.keys(credentialWaitDetailFor(reason))).not.toContain('census')
  })
})

describe.skipIf(connectionString === undefined)('recording and reading a wait', () => {
  const fixtures = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(async () => {
    await fixtures.open()
  }, 120_000)

  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  afterEach(async () => {
    await fixtures.db().delete(workflowEvents)
  })

  it('writes an entry the reader finds, with the timestamp the database assigned', async () => {
    const workflowId = await fixtures.seedWorkflow({
      label: 'recorded',
      state: 'awaiting_credential',
    })

    const since = await recordCredentialWait(fixtures.db(), { workflowId, reason })
    const found = await latestCredentialWait(fixtures.db(), workflowId)

    expect(found?.since).toStrictEqual(since)
    expect(found?.detail).toMatchObject({ kind: 'all_held', configurationFault: false })
    expect(found?.detail?.groups).toEqual([
      { name: 'shared-seats', position: 1 },
      { name: 'overflow', position: 2 },
    ])
  }, 30_000)

  it('ignores a `queued` entry that is about the concurrency ceiling', async () => {
    // The reason every read here filters on the discriminator rather than on the event name. This
    // entry is what admission writes for a run held back by FR-040 — a different wait entirely.
    const workflowId = await fixtures.seedWorkflow({ label: 'ceiling-wait' })

    await fixtures
      .db()
      .insert(workflowEvents)
      .values({
        workflowId,
        event: CREDENTIAL_WAIT_EVENT,
        actorType: 'control_plane',
        detail: { ceiling: 4, liveLeasesBefore: 4 },
      })

    expect(await latestCredentialWait(fixtures.db(), workflowId)).toBeUndefined()
  }, 30_000)

  it('takes the most recent wait when a run has waited more than once', async () => {
    const workflowId = await fixtures.seedWorkflow({
      label: 'twice',
      state: 'awaiting_credential',
    })

    const first = await recordCredentialWait(fixtures.db(), { workflowId, reason })
    const second = await recordCredentialWait(fixtures.db(), {
      workflowId,
      reason: { ...reason, kind: 'all_cooling_off' },
    })
    const found = await latestCredentialWait(fixtures.db(), workflowId)

    expect(found?.detail?.kind).toBe('all_cooling_off')
    expect(found?.since.getTime()).toBeGreaterThanOrEqual(first.getTime())
    expect(found?.since).toStrictEqual(second)
  }, 30_000)

  it('reports nothing for a run that has never waited for a credential', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'never-waited' })

    expect(await latestCredentialWait(fixtures.db(), workflowId)).toBeUndefined()
  }, 30_000)

  it('keeps the clock when the explanation will not parse', async () => {
    // An entry written by an older control plane still proves the run has been waiting since then,
    // and the clock is what FR-028 needs. Inventing an explanation would be worse than none.
    const workflowId = await fixtures.seedWorkflow({
      label: 'will-not-parse',
      state: 'awaiting_credential',
    })

    await fixtures
      .db()
      .insert(workflowEvents)
      .values({
        workflowId,
        event: CREDENTIAL_WAIT_EVENT,
        actorType: 'control_plane',
        detail: { waitingOn: 'agent_credential', kind: 'all_held' },
      })

    const found = await latestCredentialWait(fixtures.db(), workflowId)

    expect(found?.since).toBeInstanceOf(Date)
    expect(found?.detail).toBeUndefined()
  }, 30_000)
})
