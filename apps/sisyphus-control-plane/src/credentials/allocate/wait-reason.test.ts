import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { CredentialPoolFixtures } from './pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from './pool-fixtures'
import { selectFor } from './select'
import type { CredentialCensus, SearchedGroup } from './wait-reason'
import {
  bucketFor,
  classifyWaitReason,
  describeWaitReason,
  NO_CREDENTIALS,
  NO_EXECUTION_PROFILE,
  NO_GROUPS_ATTACHED,
  SEAT_AVAILABLE,
} from './wait-reason'

/**
 * **The FR-029 suite (T063) — the four answers "there is nothing available" collapses into.**
 *
 * Every test here exists because the remedy differs. All held is a capacity problem an engineer
 * waits out or fixes with a registration; all cooling off is a provider limit that clears itself
 * and wants nobody's attention at all; all unhealthy or disabled needs an administrator; and a
 * group holding **no credentials** is not a wait in any sense — it is a mistake, and a run left
 * queueing behind it will sit until FR-028's limit fails it for "exhaustion" that never existed.
 * That fourth case is the one this file is really for, and it is asserted on
 * `configurationFault` rather than on the wording, because the panel and the expiry both branch on
 * the flag and only a human reads the sentence.
 *
 * The census cases run against a real, freshly-migrated Postgres, because each is a claim about a
 * query over the same graph selection walks — the attachment join, the left join that keeps an
 * empty group visible, and the archived rows that must not be counted as capacity. None of them
 * could be proved against a fake built from the same misunderstanding as the code. They skip when
 * `SISYPHUS_TEST_DATABASE_URL` is unset, so read the skip count before believing a green.
 *
 * The classification itself is pure and is tested without a database, so the six answers can be
 * exercised as a decision table rather than by seeding six pools.
 */

const connectionString = readTestDatabaseUrl()

const census = (partial: Partial<CredentialCensus>): CredentialCensus => {
  const filled = {
    available: partial.available ?? 0,
    held: partial.held ?? 0,
    coolingOff: partial.coolingOff ?? 0,
    unavailable: partial.unavailable ?? 0,
  }
  return {
    ...filled,
    total: partial.total ?? filled.available + filled.held + filled.coolingOff + filled.unavailable,
  }
}

const group = (name: string, position: number, usable = true): SearchedGroup => ({
  credentialGroupId: `group-${name}`,
  name,
  position,
  usable,
})

describe('bucketing one credential', () => {
  it('counts an available credential with somewhere to fetch material from', () => {
    expect(
      bucketFor({ groupUsable: true, enabled: true, state: 'available', secretId: 'secret' }),
    ).toBe('available')
  })

  it('refuses an available credential with no secret (FR-008), as selection does', () => {
    // The mirror of `selectFor`'s `secret_id is not null`. Counting it would report a seat the
    // selection query has already refused, and send somebody looking for a queue that is not there.
    expect(
      bucketFor({ groupUsable: true, enabled: true, state: 'available', secretId: null }),
    ).toBe('unavailable')
  })

  it('reads held and cooling off as themselves', () => {
    expect(bucketFor({ groupUsable: true, enabled: true, state: 'held', secretId: 's' })).toBe(
      'held',
    )
    expect(
      bucketFor({ groupUsable: true, enabled: true, state: 'cooling_off', secretId: 's' }),
    ).toBe('cooling_off')
  })

  it('reads unhealthy, disabled and awaiting-login as needing an administrator', () => {
    for (const state of ['unhealthy', 'disabled', 'awaiting_login'] as const) {
      expect(bucketFor({ groupUsable: true, enabled: true, state, secretId: 's' })).toBe(
        'unavailable',
      )
    }
  })

  it('asks about the group first: a held credential in a disabled group is not capacity', () => {
    // Releasing it returns it to a group selection cannot reach, so counting it as "held" would
    // promise a seat that is coming back when it is not.
    expect(bucketFor({ groupUsable: false, enabled: true, state: 'held', secretId: 's' })).toBe(
      'unavailable',
    )
    expect(
      bucketFor({ groupUsable: false, enabled: true, state: 'available', secretId: 's' }),
    ).toBe('unavailable')
  })

  it('reads a disabled credential as unavailable whatever its state says (FR-006)', () => {
    expect(
      bucketFor({ groupUsable: true, enabled: false, state: 'available', secretId: 's' }),
    ).toBe('unavailable')
  })

  /**
   * **T115 — a seat disabled *while a run holds it* is not capacity that is coming back.**
   *
   * The order of the checks in `bucketFor` is the whole rule, and this is the case that decides it:
   * `enabled` is asked **before** `state`, so a held-and-disabled credential counts as unavailable
   * rather than as held. Ask `state` first and the census reports it as held, the classification
   * says `all_held`, and the remedy tells an engineer to wait for a run to finish — for a seat that
   * will be withheld from selection the moment that run ends. That is a queue waiting on capacity
   * that will never arrive, and it is what FR-029's third case exists to distinguish.
   */
  it('reads a seat disabled while a run holds it as unavailable, not as held (FR-006, FR-029)', () => {
    expect(bucketFor({ groupUsable: true, enabled: false, state: 'held', secretId: 's' })).toBe(
      'unavailable',
    )
    // Same for a seat disabled while the provider is throttling it: releasing or clearing returns
    // it to a pool selection still cannot draw from.
    expect(
      bucketFor({ groupUsable: true, enabled: false, state: 'cooling_off', secretId: 's' }),
    ).toBe('unavailable')
  })
})

describe('classifying a wait (FR-029)', () => {
  it('reports all held as capacity that is coming back', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('alpha', 1), group('beta', 2)],
      census: census({ held: 3 }),
    })

    expect(reason.kind).toBe('all_held')
    expect(reason.configurationFault).toBe(false)
    // Named, in preference order — FR-029's "name the attached groups that were searched".
    expect(reason.summary).toContain('alpha (position 1)')
    expect(reason.summary).toContain('beta (position 2)')
    expect(reason.remedy).toMatch(/wait for a run to finish|register more credentials/i)
  })

  it('reports all cooling off as something that clears without anyone acting', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('alpha', 1)],
      census: census({ coolingOff: 2 }),
    })

    expect(reason.kind).toBe('all_cooling_off')
    expect(reason.configurationFault).toBe(false)
    expect(reason.summary).toContain('alpha (position 1)')
    // The distinction FR-075 insists on: a provider limit is not a breakage and raises nobody.
    expect(reason.remedy).toMatch(/without any administrator action/i)
  })

  it('reports all unhealthy or disabled as needing an administrator', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('alpha', 1)],
      census: census({ unavailable: 2 }),
    })

    expect(reason.kind).toBe('all_unhealthy_or_disabled')
    expect(reason.remedy).toMatch(/administrator has to act/i)
    // Not a configuration fault: the groups do hold credentials, and repairing one ends the wait.
    expect(reason.configurationFault).toBe(false)
  })

  it('reports empty groups as a configuration fault rather than a wait', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('alpha', 1)],
      census: census({}),
    })

    expect(reason.kind).toBe(NO_CREDENTIALS)
    // The whole point of the flag. Nothing is held, so nothing will be released, so the queue this
    // run is in has nothing behind it — and FR-028 would eventually fail it naming exhaustion.
    expect(reason.configurationFault).toBe(true)
    // Still grantable, though: registering a credential in one of these groups is enough, and the
    // drain then grants it without anybody touching the run. That is the difference from a run
    // with no execution profile, which nothing short of a relaunch can serve.
    expect(reason.grantable).toBe(true)
    expect(reason.summary).toContain('no credentials at all')
    expect(reason.summary).toContain('alpha (position 1)')
  })

  it('reports a profile with no attachments as a configuration fault', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [],
      census: census({}),
    })

    expect(reason.kind).toBe(NO_GROUPS_ATTACHED)
    expect(reason.configurationFault).toBe(true)
    // Attaching a group is enough — the grant path would then reach this run.
    expect(reason.grantable).toBe(true)
  })

  it('reports a run with no execution profile as one nothing can serve, not as exhaustion', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: false,
      groups: [],
      census: census({}),
    })

    expect(reason.kind).toBe(NO_EXECUTION_PROFILE)
    expect(reason.configurationFault).toBe(true)
    // The one kind nothing can be granted to. Admission branches on this to keep such a run out of
    // `awaiting_credential` altogether, rather than parking it in a queue nothing can serve it from.
    expect(reason.grantable).toBe(false)
    // The sentence has to say why waiting cannot help: no grant can reach a run with no profile,
    // because the grant path joins through the same attachments selection does.
    expect(reason.remedy).toMatch(/no release by any other run can ever be granted/i)
  })

  it('reports a mixture as a mixture, because a single remedy would only half fix it', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('alpha', 1)],
      census: census({ held: 1, coolingOff: 1, unavailable: 1 }),
    })

    expect(reason.kind).toBe('mixed')
    expect(reason.summary).toContain('1 held, 1 cooling off, 1 unhealthy or disabled')
  })

  it('says so plainly when the census finds a seat selection did not', () => {
    // Not only a bug: a seat can be released between the `limit 1` selection and this second pass,
    // and reporting that as exhaustion would be a sentence that is simply untrue.
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('alpha', 1)],
      census: census({ available: 1, held: 1 }),
    })

    expect(reason.kind).toBe(SEAT_AVAILABLE)
    expect(reason.configurationFault).toBe(false)
  })

  it('names a disabled or archived group as such, rather than hiding it', () => {
    const reason = classifyWaitReason({
      hasExecutionProfile: true,
      groups: [group('switched-off', 1, false)],
      census: census({ unavailable: 1 }),
    })

    expect(reason.summary).toContain('switched-off (position 1, disabled or archived)')
  })
})

describe.skipIf(connectionString === undefined)('explaining a wait over a live pool', () => {
  // Narrowed once: `describe.skipIf` has already decided, but TypeScript has not seen it.
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(connectionString ?? '')

  beforeAll(async () => {
    await fixtures.open()
  }, 120_000)

  // The same generous budget the other suites in this directory give it, for the same reason:
  // `drop database … with (force)` runs against a server several suites are concurrently creating
  // and dropping databases on, and the default ten seconds is a limit on the container.
  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  /** A workflow under a profile attached to one group seeded by `seed`. */
  const scenario = async (
    label: string,
    seed: (credentialGroupId: string) => Promise<void>,
    groupOptions: { readonly enabled?: boolean; readonly archived?: boolean } = {},
  ): Promise<string> => {
    const credentialGroupId = await fixtures.seedGroup({ label: `${label}-group`, ...groupOptions })
    await seed(credentialGroupId)
    const executionProfileId = await fixtures.seedProfile({
      label: `${label}-profile`,
      groups: [{ credentialGroupId, position: 1 }],
    })

    return fixtures.seedWorkflow({
      label: `${label}-run`,
      executionProfileId,
      state: 'awaiting_credential',
    })
  }

  it('reports every reachable credential held, naming the group (FR-029)', async () => {
    const workflowId = await scenario('held', async (credentialGroupId) => {
      for (const index of [0, 1]) {
        await fixtures.seedCredential({
          label: `held-${String(index)}`,
          credentialGroupId,
          state: 'held',
        })
      }
    })

    // The premise: selection really does find nothing, so the report is explaining a real absence.
    expect(await selectFor(fixtures.db(), { workflowId })).toBeUndefined()

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe('all_held')
    expect(reason.census).toMatchObject({ held: 2, total: 2, available: 0 })
    expect(reason.groups).toHaveLength(1)
    expect(reason.groups[0]?.name).toContain('held-group')
    expect(reason.summary).toContain(reason.groups[0]?.name ?? '')
  }, 30_000)

  it('reports every reachable credential cooling off', async () => {
    const workflowId = await scenario('cooling', async (credentialGroupId) => {
      for (const index of [0, 1]) {
        await fixtures.seedCredential({
          label: `cooling-${String(index)}`,
          credentialGroupId,
          state: 'cooling_off',
        })
      }
    })

    expect(await selectFor(fixtures.db(), { workflowId })).toBeUndefined()

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe('all_cooling_off')
    expect(reason.census).toMatchObject({ coolingOff: 2, total: 2 })
    expect(reason.configurationFault).toBe(false)
  }, 30_000)

  it('reports every reachable credential unhealthy or disabled', async () => {
    const workflowId = await scenario('broken', async (credentialGroupId) => {
      await fixtures.seedCredential({
        label: 'broken-unhealthy',
        credentialGroupId,
        state: 'unhealthy',
      })
      await fixtures.seedCredential({
        label: 'broken-switched-off',
        credentialGroupId,
        enabled: false,
      })
      // Available on paper and unusable in fact: FR-008 says a credential with nowhere to fetch
      // material from is not capacity, and selection excludes it for the same reason.
      await fixtures.seedCredential({
        label: 'broken-no-secret',
        credentialGroupId,
        secretId: null,
      })
    })

    expect(await selectFor(fixtures.db(), { workflowId })).toBeUndefined()

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe('all_unhealthy_or_disabled')
    expect(reason.census).toMatchObject({ unavailable: 3, total: 3 })
    expect(reason.remedy).toMatch(/administrator/i)
  }, 30_000)

  it('reports attached groups holding no credentials at all as a configuration fault', async () => {
    // The case that matters. Nothing is held here, so nothing will ever be released to this run —
    // it is a mistake somebody has to fix, and a platform that answered "no capacity" would have it
    // sit in the queue until FR-028's limit failed it for exhaustion that never happened.
    const workflowId = await scenario('barren', async () => {
      // Deliberately nothing.
    })

    expect(await selectFor(fixtures.db(), { workflowId })).toBeUndefined()

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe(NO_CREDENTIALS)
    expect(reason.configurationFault).toBe(true)
    expect(reason.census).toMatchObject({ total: 0 })
    // Still names the group it searched: "which pool is empty" is the actionable half.
    expect(reason.groups).toHaveLength(1)
    expect(reason.summary).toContain(reason.groups[0]?.name ?? '')
  }, 30_000)

  it('does not count archived credentials as capacity (FR-005, FR-066)', async () => {
    // An archived credential is history, not a disabled seat. A group whose only members have been
    // archived is empty, and reporting it as "all disabled" would describe capacity an
    // administrator believes is gone.
    const workflowId = await scenario('archived-members', async (credentialGroupId) => {
      await fixtures.seedCredential({
        label: 'archived-member',
        credentialGroupId,
        archived: true,
      })
    })

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe(NO_CREDENTIALS)
    expect(reason.census.total).toBe(0)
  }, 30_000)

  it('names an archived group rather than dropping it from the search', async () => {
    const workflowId = await scenario(
      'archived-group',
      async (credentialGroupId) => {
        await fixtures.seedCredential({ label: 'stranded', credentialGroupId })
      },
      { archived: true },
    )

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.groups[0]?.usable).toBe(false)
    expect(reason.kind).toBe('all_unhealthy_or_disabled')
    expect(reason.summary).toContain('disabled or archived')
  }, 30_000)

  it('searches the profile’s groups in preference order', async () => {
    const first = await fixtures.seedGroup({ label: 'order-first' })
    const second = await fixtures.seedGroup({ label: 'order-second' })
    await fixtures.seedCredential({
      label: 'order-first-held',
      credentialGroupId: first,
      state: 'held',
    })
    await fixtures.seedCredential({
      label: 'order-second-held',
      credentialGroupId: second,
      state: 'held',
    })
    const executionProfileId = await fixtures.seedProfile({
      label: 'order-profile',
      groups: [
        { credentialGroupId: second, position: 1 },
        { credentialGroupId: first, position: 2 },
      ],
    })
    const workflowId = await fixtures.seedWorkflow({
      label: 'order-run',
      executionProfileId,
      state: 'awaiting_credential',
    })

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    // The order the search was performed in, not the order the groups were created in.
    expect(reason.groups.map((searched) => searched.credentialGroupId)).toEqual([second, first])
    expect(reason.groups.map((searched) => searched.position)).toEqual([1, 2])
  }, 30_000)

  it('reports a run with no execution profile as one nothing can serve rather than waiting', async () => {
    // The trap this distinction exists for: `selectFor` joins out through the profile, and so does
    // the grant path. A run with no profile can never be granted a seat by anybody, so calling it
    // "waiting" would be waiting for something that was never coming.
    const workflowId = await fixtures.seedWorkflow({ label: 'ad-hoc-run' })

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe(NO_EXECUTION_PROFILE)
    expect(reason.configurationFault).toBe(true)
    expect(reason.groups).toEqual([])
  }, 30_000)

  it('reports a profile with no attached groups as a configuration fault', async () => {
    const executionProfileId = await fixtures.seedProfile({ label: 'unattached', groups: [] })
    const workflowId = await fixtures.seedWorkflow({
      label: 'unattached-run',
      executionProfileId,
      state: 'awaiting_credential',
    })

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe(NO_GROUPS_ATTACHED)
    expect(reason.configurationFault).toBe(true)
  }, 30_000)

  it('says a seat is available when one is, rather than inventing exhaustion', async () => {
    const workflowId = await scenario('spare', async (credentialGroupId) => {
      await fixtures.seedCredential({ label: 'spare-free', credentialGroupId })
      await fixtures.seedCredential({
        label: 'spare-held',
        credentialGroupId,
        state: 'held',
      })
    })

    const reason = await describeWaitReason(fixtures.db(), { workflowId })

    expect(reason.kind).toBe(SEAT_AVAILABLE)
    expect(reason.census).toMatchObject({ available: 1, held: 1, total: 2 })
  }, 30_000)

  /**
   * **T115 — a seat disabled while workflows wait must not leave the queue waiting on capacity that
   * will never arrive (FR-006, FR-029, SC-012).**
   *
   * The sequence US9 produces, in the order it happens. A run holds the only seat this profile can
   * reach and another run queues behind it, so the queue is genuinely waiting for a release —
   * `all_held`, "wait for a run to finish", which is true and actionable. An administrator then
   * disables the seat, because its login has broken and disabling is the first step of recovering
   * it (FR-006 withholds from future selection and deliberately evicts nobody).
   *
   * At that instant the queue's premise stops being true, and nothing in the pool announces it: the
   * seat is still `held`, the run still holds it, and the release is still coming. What is no longer
   * coming is the **capacity** — a disabled seat is withheld from selection whatever state it is in,
   * so the release the queue is waiting for will produce nothing for it.
   *
   * The assertion is therefore on the census and the classification rather than on the wording:
   * that the seat has stopped being counted as `held`, and that the report has stopped saying
   * waiting for a run to finish is what fixes this. The wording is checked too, but only as a
   * consequence — the panel and FR-028's expiry both read the classification, and only a person
   * reads the sentence.
   */
  it('stops promising capacity once the seat the queue is waiting on is disabled (FR-029)', async () => {
    const credentialGroupId = await fixtures.seedGroup({ label: 'disabled-mid-wait-group' })
    const credentialId = await fixtures.seedCredential({
      label: 'disabled-mid-wait-seat',
      credentialGroupId,
      state: 'held',
      heldBy: 'workflow',
    })
    const executionProfileId = await fixtures.seedProfile({
      label: 'disabled-mid-wait-profile',
      groups: [{ credentialGroupId, position: 1 }],
    })
    const waitingId = await fixtures.seedWorkflow({
      label: 'disabled-mid-wait-run',
      executionProfileId,
      state: 'awaiting_credential',
    })

    const before = await describeWaitReason(fixtures.db(), { workflowId: waitingId })

    // The premise: a real wait for a real release, and the remedy says as much.
    expect(before.kind).toBe('all_held')
    expect(before.census).toMatchObject({ held: 1, unavailable: 0, total: 1 })
    expect(before.remedy).toMatch(/wait for a run to finish/i)

    // The administrator disables the seat. Nothing else changes: the run keeps it (FR-006), the
    // state column still says `held`, and the lease is untouched.
    await fixtures
      .db()
      .execute(sql`update agent_credentials set enabled = false where id = ${credentialId}`)

    const after = await describeWaitReason(fixtures.db(), { workflowId: waitingId })

    // **It is no longer counted as capacity.** A census that still read it as `held` would be
    // describing a seat that is coming back, and it is not coming back to this queue.
    expect(after.census).toMatchObject({ held: 0, unavailable: 1, total: 1 })
    expect(after.kind).toBe('all_unhealthy_or_disabled')

    // And the report no longer offers waiting as the remedy. Somebody has to act — re-enable it, or
    // repair and re-log-in the seat — and the run will otherwise sit until FR-028's limit.
    expect(after.remedy).toMatch(/administrator has to act/i)
    expect(after.remedy).toMatch(/will not clear this on its own/i)
    expect(after.remedy).not.toMatch(/wait for a run to finish/i)
    expect(after.summary).toContain('unhealthy, disabled, or awaiting a login')

    // Still not a configuration fault, and the distinction is worth pinning rather than assuming:
    // the groups do hold a credential, and re-enabling it ends the wait with no relaunch — the
    // grant path reaches this run again by itself. That is what separates it from an attached group
    // holding nothing, which no release and no re-enable will ever fill.
    expect(after.configurationFault).toBe(false)
    expect(after.grantable).toBe(true)
  }, 30_000)

  it('refuses to explain a wait for a workflow that does not exist', async () => {
    await expect(
      describeWaitReason(fixtures.db(), { workflowId: crypto.randomUUID() }),
    ).rejects.toThrow(/does not exist/)
  }, 30_000)
})
