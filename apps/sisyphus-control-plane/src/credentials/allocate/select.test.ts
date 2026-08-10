import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyHealthVerdict, classifyProviderResponse } from '../health'

import type { CredentialPoolFixtures } from './pool-fixtures'
import { createCredentialPoolFixtures, readTestDatabaseUrl } from './pool-fixtures'
import { selectFor } from './select'

/**
 * **The scoping suite (T036) — the executable form of SC-016.**
 *
 * SC-016 says work launched under an execution profile is never performed by a credential outside
 * that profile's attached groups. That is a claim about *every* run, so a test that showed one
 * happy path would be evidence of almost nothing: the interesting failure is a query that is right
 * for the shape the author had in mind and wrong for the shape nobody tried. So the middle of this
 * file enumerates **every ordered combination of attachable groups the fixture can construct** —
 * fifteen of them over three groups — and asserts against each that selection returned the exact
 * credential the contract names, and that it came from a group the profile is actually attached to.
 *
 * A fourth group, `outsider`, is deliberately never attached to any profile and holds the most
 * attractive credential in the database: `available`, enabled, never used, so it sorts first on
 * every ordering key selection uses. If scoping were dropped from the query, it would be returned
 * for every one of the fifteen cases rather than for some awkward corner — which is what makes its
 * absence from the results meaningful rather than lucky.
 *
 * Everything here runs against a real, freshly-migrated Postgres, because every claim it makes is a
 * claim about a query: the group-order fall-through, the `NULLS FIRST` LRU tie-break, and the join
 * that bounds candidates to the workflow's own profile. None of them can be proved against a mock
 * that would be built from the same misunderstanding as the code. The suite skips when
 * `SISYPHUS_TEST_DATABASE_URL` is unset, so read the skip count before believing a green.
 */

const connectionString = readTestDatabaseUrl()

/** The groups selection is allowed to be pointed at, in the combinations below. */
type Attachable = 'alpha' | 'barren' | 'beta'

const ATTACHABLE: readonly Attachable[] = ['alpha', 'beta', 'barren']

/**
 * Every ordered, non-empty selection of the attachable groups — 3 singles, 6 pairs, 6 triples.
 *
 * Order matters and is half the point: `[beta, alpha]` and `[alpha, beta]` are different
 * configurations that must produce different credentials, and a query that sorted by anything other
 * than `position` would pass one and fail the other.
 */
const orderedCombinations = <TItem>(items: readonly TItem[]): TItem[][] => {
  const results: TItem[][] = []
  const walk = (chosen: TItem[], remaining: readonly TItem[]): void => {
    if (chosen.length > 0) results.push([...chosen])
    remaining.forEach((item, index) => {
      walk(
        [...chosen, item],
        remaining.filter((_, other) => other !== index),
      )
    })
  }
  walk([], items)
  return results
}

const COMBINATIONS = orderedCombinations(ATTACHABLE)

describe.skipIf(connectionString === undefined)('selecting a credential for a workflow', () => {
  // Narrowed once: `describe.skipIf` has already decided, but TypeScript has not seen it.
  const url = connectionString ?? ''
  const fixtures: CredentialPoolFixtures = createCredentialPoolFixtures(url)

  /** Group ids, by the name the combinations use. */
  const groups = new Map<string, string>()
  /** Credential ids by label, so assertions name a credential rather than an index. */
  const credentials = new Map<string, string>()
  /** One workflow per combination, keyed by the combination's join. */
  const workflowFor = new Map<string, string>()

  const groupId = (name: string): string => groups.get(name) ?? ''
  const credentialId = (label: string): string => credentials.get(label) ?? ''

  /**
   * The credential the contract's loop would return for one ordering.
   *
   * Written out independently of the query under test — walk the groups in order, take the first
   * that has any candidate, and name its least-recently-used member — so that agreement between
   * this and `selectFor` means something. `barren` contributes nothing, which is the fall-through.
   */
  const expected = (ordering: readonly Attachable[]): string | undefined => {
    for (const name of ordering) {
      if (name === 'alpha') return credentialId('alpha-older')
      if (name === 'beta') return credentialId('beta-never-used')
    }
    return undefined
  }

  beforeAll(async () => {
    await fixtures.open()
  }, 120_000)

  // The same generous budget `beforeAll` gets, and for the mirror-image reason: `close()` issues
  // `drop database … with (force)` against a server several suites are concurrently creating and
  // dropping databases on, and the default ten seconds is a limit on the container rather than on
  // anything this suite does.
  afterAll(async () => {
    await fixtures.close()
  }, 120_000)

  beforeAll(async () => {
    for (const name of ['alpha', 'beta', 'barren', 'outsider']) {
      groups.set(name, await fixtures.seedGroup({ label: name }))
    }
    groups.set('switched-off', await fixtures.seedGroup({ label: 'switched-off', enabled: false }))
    groups.set('archived', await fixtures.seedGroup({ label: 'archived', archived: true }))

    const seed = async (
      label: string,
      options: Parameters<CredentialPoolFixtures['seedCredential']>[0],
    ): Promise<void> => {
      credentials.set(label, await fixtures.seedCredential(options))
    }

    // `alpha` — two usable credentials, distinguished only by when they were last used.
    await seed('alpha-older', {
      label: 'alpha-older',
      credentialGroupId: groupId('alpha'),
      lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await seed('alpha-newer', {
      label: 'alpha-newer',
      credentialGroupId: groupId('alpha'),
      lastUsedAt: new Date('2026-06-01T00:00:00.000Z'),
    })

    // `beta` — one never used and one used long ago, so `NULLS FIRST` is what decides.
    await seed('beta-never-used', {
      label: 'beta-never-used',
      credentialGroupId: groupId('beta'),
      lastUsedAt: null,
    })
    await seed('beta-ancient', {
      label: 'beta-ancient',
      credentialGroupId: groupId('beta'),
      lastUsedAt: new Date('2020-01-01T00:00:00.000Z'),
    })

    // `barren` — one credential for every reason a credential is passed over. The group is enabled
    // and non-empty, so a query that fell through on "no rows in the group" rather than on "no
    // *candidates* in the group" would stop here instead of reaching the next preference.
    await seed('barren-held', {
      label: 'barren-held',
      credentialGroupId: groupId('barren'),
      state: 'held',
      lastUsedAt: null,
    })
    await seed('barren-unhealthy', {
      label: 'barren-unhealthy',
      credentialGroupId: groupId('barren'),
      state: 'unhealthy',
      lastUsedAt: null,
    })
    await seed('barren-cooling-off', {
      label: 'barren-cooling-off',
      credentialGroupId: groupId('barren'),
      state: 'cooling_off',
      lastUsedAt: null,
    })
    await seed('barren-awaiting-login', {
      label: 'barren-awaiting-login',
      credentialGroupId: groupId('barren'),
      state: 'awaiting_login',
      secretId: null,
      lastUsedAt: null,
    })
    await seed('barren-state-disabled', {
      label: 'barren-state-disabled',
      credentialGroupId: groupId('barren'),
      state: 'disabled',
      lastUsedAt: null,
    })
    await seed('barren-withheld', {
      label: 'barren-withheld',
      credentialGroupId: groupId('barren'),
      enabled: false,
      lastUsedAt: null,
    })
    await seed('barren-archived', {
      label: 'barren-archived',
      credentialGroupId: groupId('barren'),
      archived: true,
      lastUsedAt: null,
    })
    await seed('barren-no-material', {
      label: 'barren-no-material',
      credentialGroupId: groupId('barren'),
      secretId: null,
      lastUsedAt: null,
    })

    // `outsider` — the most attractive credential in the database, attached to nothing.
    await seed('outsider', {
      label: 'outsider',
      credentialGroupId: groupId('outsider'),
      lastUsedAt: null,
    })

    // Two whole-group refusals, each holding a credential that would otherwise win outright.
    await seed('in-switched-off-group', {
      label: 'in-switched-off-group',
      credentialGroupId: groupId('switched-off'),
      lastUsedAt: null,
    })
    await seed('in-archived-group', {
      label: 'in-archived-group',
      credentialGroupId: groupId('archived'),
      lastUsedAt: null,
    })

    for (const ordering of COMBINATIONS) {
      const key = ordering.join('>')
      const profileId = await fixtures.seedProfile({
        label: `profile-${key}`,
        groups: ordering.map((name, index) => ({
          credentialGroupId: groupId(name),
          position: index + 1,
        })),
      })
      workflowFor.set(
        key,
        await fixtures.seedWorkflow({ label: `workflow-${key}`, executionProfileId: profileId }),
      )
    }
  }, 60_000)

  it('constructed every ordered combination, so a broken generator cannot pass silently', () => {
    expect(COMBINATIONS).toHaveLength(15)
    expect(workflowFor.size).toBe(15)
  })

  describe.each(COMBINATIONS.map((ordering) => ({ ordering, key: ordering.join('>') })))(
    'a profile attached to $key',
    ({ ordering, key }) => {
      it('returns the credential the allocation protocol names, and only that one', async () => {
        const selected = await selectFor(fixtures.db(), {
          workflowId: workflowFor.get(key) ?? '',
        })

        expect(selected?.agentCredentialId).toBe(expected(ordering))
      })

      it('never reaches a group this profile is not attached to (SC-016, FR-063)', async () => {
        const selected = await selectFor(fixtures.db(), {
          workflowId: workflowFor.get(key) ?? '',
        })

        const attached = ordering.map((name) => groupId(name))
        if (selected !== undefined) {
          expect(attached).toContain(selected.credentialGroupId)
        }
        // Stated separately and positively: the never-attached group holds the credential that
        // would win every ordering if the scoping join were dropped.
        expect(selected?.agentCredentialId).not.toBe(credentialId('outsider'))
        expect(selected?.credentialGroupId).not.toBe(groupId('outsider'))
      })
    },
  )

  it('tries groups in position order, not in the order they happened to be created (FR-064)', async () => {
    // The pair of orderings over the same two groups is the whole claim, restated on its own so a
    // failure here reads as "preference order was ignored" rather than as one of thirty rows.
    const alphaFirst = await selectFor(fixtures.db(), {
      workflowId: workflowFor.get('alpha>beta') ?? '',
    })
    const betaFirst = await selectFor(fixtures.db(), {
      workflowId: workflowFor.get('beta>alpha') ?? '',
    })

    expect(alphaFirst?.agentCredentialId).toBe(credentialId('alpha-older'))
    expect(betaFirst?.agentCredentialId).toBe(credentialId('beta-never-used'))
  })

  it('falls through a group that has credentials but none available (FR-064)', async () => {
    // `barren` is enabled and holds eight rows. A lower-preference group is reached because none of
    // them is a *candidate*, which is a different test from "the group is empty".
    const selected = await selectFor(fixtures.db(), {
      workflowId: workflowFor.get('barren>alpha') ?? '',
    })

    expect(selected?.agentCredentialId).toBe(credentialId('alpha-older'))
    expect(selected?.position).toBe(2)
  })

  it('returns nothing when every reachable group is barren', async () => {
    const selected = await selectFor(fixtures.db(), {
      workflowId: workflowFor.get('barren') ?? '',
    })

    expect(selected).toBeUndefined()
  })

  it('prefers the least recently used within the chosen group (FR-034)', async () => {
    const selected = await selectFor(fixtures.db(), {
      workflowId: workflowFor.get('alpha') ?? '',
    })

    expect(selected?.agentCredentialId).toBe(credentialId('alpha-older'))
    expect(selected?.lastUsedAt).toStrictEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('sorts a never-used credential first, ahead of one used years ago', async () => {
    // `NULLS FIRST` rather than an accident of how Postgres orders nulls by default — which is
    // `NULLS LAST` on an ascending sort, so the default would pick exactly the wrong row.
    const selected = await selectFor(fixtures.db(), {
      workflowId: workflowFor.get('beta') ?? '',
    })

    expect(selected?.agentCredentialId).toBe(credentialId('beta-never-used'))
    expect(selected?.lastUsedAt).toBeNull()
  })

  it('withholds every member of a disabled group (FR-006 applied group-wide)', async () => {
    const profileId = await fixtures.seedProfile({
      label: 'only-switched-off',
      groups: [{ credentialGroupId: groupId('switched-off'), position: 1 }],
    })
    const workflowId = await fixtures.seedWorkflow({
      label: 'only-switched-off',
      executionProfileId: profileId,
    })

    await expect(selectFor(fixtures.db(), { workflowId })).resolves.toBeUndefined()
  })

  it('withholds every member of an archived group, and falls through to the next', async () => {
    const profileId = await fixtures.seedProfile({
      label: 'archived-then-alpha',
      groups: [
        { credentialGroupId: groupId('archived'), position: 1 },
        { credentialGroupId: groupId('switched-off'), position: 2 },
        { credentialGroupId: groupId('alpha'), position: 3 },
      ],
    })
    const workflowId = await fixtures.seedWorkflow({
      label: 'archived-then-alpha',
      executionProfileId: profileId,
    })

    const selected = await selectFor(fixtures.db(), { workflowId })
    expect(selected?.agentCredentialId).toBe(credentialId('alpha-older'))
    expect(selected?.position).toBe(3)
  })

  it('returns nothing for a profile with no attachments at all', async () => {
    // FR-065 refuses this configuration at save time, so it is not a runtime case — but selection
    // inventing capacity for it would be a far worse failure than the refusal being bypassed.
    const profileId = await fixtures.seedProfile({ label: 'unattached', groups: [] })
    const workflowId = await fixtures.seedWorkflow({
      label: 'unattached',
      executionProfileId: profileId,
    })

    await expect(selectFor(fixtures.db(), { workflowId })).resolves.toBeUndefined()
  })

  it('returns nothing for an ad-hoc run, which is attached to no profile and so to no group', async () => {
    const workflowId = await fixtures.seedWorkflow({ label: 'ad-hoc' })

    await expect(selectFor(fixtures.db(), { workflowId })).resolves.toBeUndefined()
  })

  it('returns nothing for a workflow that does not exist, rather than anything at all', async () => {
    // The scoping join starts at the workflow row, so an unknown id reaches no attachment and
    // therefore no credential. Worth asserting: a query that started at `profile_credential_groups`
    // and filtered afterwards would return the whole pool here.
    await expect(
      selectFor(fixtures.db(), { workflowId: '00000000-0000-7000-8000-000000000000' }),
    ).resolves.toBeUndefined()
  })

  /**
   * **T119 / SC-010 — a credential that becomes unhealthy leaves the candidate set before it can be
   * issued to a second workflow.**
   *
   * The exclusion itself is already in the query: `state = 'available'` is the only state
   * `selectFor` accepts, and `barren-unhealthy` above proves a permanently-unhealthy seat is passed
   * over. What that does *not* pin is SC-010's actual shape, which is about a **transition**: a seat
   * that was a perfectly good candidate a moment ago, that one workflow has already been given, and
   * that the provider has since rejected.
   *
   * **The assertion is made on the selection query and deliberately not on a second workflow's
   * failure.** The two are not equivalent and the difference is the whole criterion. A test that
   * gave the seat to a second run and asserted that run then failed would pass against an
   * implementation that issued the broken seat and broke afterwards — which is precisely the
   * behaviour SC-010 forbids, and the pass would be indistinguishable from the requirement being
   * met. So the second workflow here asks and is **not offered the seat**: there is no failure
   * downstream because there is nothing downstream.
   *
   * The credential is moved by `applyHealthVerdict` rather than by an `UPDATE` in this file, so what
   * is being asserted is the real detection path — the one an auth failure from the provider
   * actually travels — reaching the real selection query.
   */
  it('drops a credential the provider has rejected out of the candidate set (SC-010)', async () => {
    const groupIdForBreak = await fixtures.seedGroup({ label: 'sc010' })
    const profileId = await fixtures.seedProfile({
      label: 'sc010',
      groups: [{ credentialGroupId: groupIdForBreak, position: 1 }],
    })
    const breakingId = await fixtures.seedCredential({
      label: 'sc010-breaking',
      credentialGroupId: groupIdForBreak,
      lastUsedAt: null,
    })

    // The premise: it is the seat this profile's runs get, so its later absence means something.
    const first = await fixtures.seedWorkflow({
      label: 'sc010-first',
      executionProfileId: profileId,
    })
    expect((await selectFor(fixtures.db(), { workflowId: first }))?.agentCredentialId).toBe(
      breakingId,
    )

    // The provider rejects the session. `classifyProviderResponse` reads 401 as a broken login
    // rather than as a limit (FR-075), so the seat lands `unhealthy` and not `cooling_off`.
    const transition = await applyHealthVerdict({
      db: fixtures.db(),
      agentCredentialId: breakingId,
      verdict: classifyProviderResponse({ status: 401 }),
    })
    expect(transition).toMatchObject({ to: 'unhealthy' })

    // A second workflow asks, and is offered nothing. This is SC-010, and it is answered here
    // rather than by watching a second run fail — a run that got the seat has already lost.
    const second = await fixtures.seedWorkflow({
      label: 'sc010-second',
      executionProfileId: profileId,
    })
    await expect(selectFor(fixtures.db(), { workflowId: second })).resolves.toBeUndefined()
  })

  it('takes no parameter by which a caller could ask for another profile’s groups', () => {
    // SC-016 is an invariant of this function rather than something to audit for, and that is only
    // true while the workflow id is the *only* way in. A `credentialGroupId` or
    // `executionProfileId` parameter would move the guarantee to every call site.
    const options: Parameters<typeof selectFor>[1] = { workflowId: 'x' }
    expect(Object.keys(options)).toStrictEqual(['workflowId'])
  })
})
