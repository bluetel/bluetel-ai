import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  agentCredentials,
  credentialLeases,
  executionProfiles,
  profileCredentialGroups,
} from '../../db'

import {
  attachCredentialGroup,
  countLeasesForCredential,
  countLiveLeasesForCredential,
  countLiveLeasesInGroup,
  detachCredentialGroup,
  findAgentCredential,
  findCredentialGroup,
  findCredentialGroupByName,
  findLiveLeaseForCredential,
  insertCredentialGroup,
  listCredentialGroups,
  listSelectableCredentials,
  readCredentialGroupReferences,
  readProfileCredentialGroups,
  recordAgentCredentialLogin,
  reorderCredentialGroups,
  updateAgentCredential,
  updateCredentialGroup,
} from './credential-store'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * The store against a real Postgres, because most of what it claims is only true there.
 *
 * The renumbering in particular cannot be proved against a mock: the failure it exists to prevent
 * is `profile_credential_groups_position_key` firing *mid-statement*, which is a property of the
 * database's row-at-a-time uniqueness checking and not of the SQL the store emits. A fake would
 * accept the naive `position = position + 1` this module deliberately does not use.
 */
const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)('credential-store against a live database', () => {
  const fixtures = createUserFixtures(liveDatabaseUrl ?? '')

  let admin = { id: '', email: '' }

  const db = () => fixtures.db()

  const seedGroup = async (label: string) =>
    insertCredentialGroup(db(), {
      name: `${label}-${fixtures.suffix}`,
      description: undefined,
      createdByUserId: admin.id,
    })

  /** A profile with no version, which is all an attachment needs — attachments hang off the parent row. */
  const seedProfile = async (label: string): Promise<string> => {
    const [profile] = await db()
      .insert(executionProfiles)
      .values({ name: `${label}-${fixtures.suffix}` })
      .returning({ id: executionProfiles.id })
    return profile.id
  }

  const seedCredential = async (label: string, credentialGroupId: string): Promise<string> => {
    const [credential] = await db()
      .insert(agentCredentials)
      .values({
        credentialGroupId,
        name: `${label}-${fixtures.suffix}`,
        state: 'awaiting_login',
        createdByUserId: admin.id,
      })
      .returning({ id: agentCredentials.id })
    return credential.id
  }

  const positionsFor = async (executionProfileId: string): Promise<readonly number[]> =>
    (await readProfileCredentialGroups(db(), executionProfileId)).map((row) => row.position)

  const namesFor = async (executionProfileId: string): Promise<readonly string[]> =>
    (await readProfileCredentialGroups(db(), executionProfileId)).map((row) => row.name)

  beforeAll(async () => {
    await fixtures.open()
    admin = await fixtures.seedUser({ label: 'credential-store-admin', role: 'admin' })
  }, 60_000)

  afterAll(async () => {
    await fixtures.close()
  }, 30_000)

  describe('credential groups', () => {
    it('creates a group enabled, because an empty group has nothing to prove (FR-060)', async () => {
      const group = await seedGroup('store-enabled')

      expect(group.enabled).toBe(true)
      expect(group.archivedAt).toBeNull()
      expect(group.createdByUserId).toBe(admin.id)
    })

    it('finds a group by name case-insensitively, exactly as the citext index matches', async () => {
      await seedGroup('store-Casing')

      // The column is `citext`, so `Store-Casing` and `store-casing` are the *same name* to the
      // unique index. A lookup that disagreed would let a duplicate reach the index and surface as
      // a driver error instead of a named refusal.
      const found = await findCredentialGroupByName(db(), `STORE-CASING-${fixtures.suffix}`)
      expect(found?.name).toBe(`store-Casing-${fixtures.suffix}`)
    })

    it('reports no group by that name rather than throwing', async () => {
      await expect(
        findCredentialGroupByName(db(), `absent-${fixtures.suffix}`),
      ).resolves.toBeUndefined()
    })

    it('lists groups with their membership and attachment counts', async () => {
      const group = await seedGroup('store-counted')
      await seedCredential('store-counted-a', group.id)
      await seedCredential('store-counted-b', group.id)

      const profileId = await seedProfile('store-counted-profile')
      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: group.id,
      })

      const page = await listCredentialGroups(db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 50,
      })

      expect(page.items.find((item) => item.id === group.id)).toMatchObject({
        credentialCount: 2,
        attachedProfileCount: 1,
      })
    })

    it('excludes archived groups unless asked for them', async () => {
      const group = await seedGroup('store-archived')
      await updateCredentialGroup(db(), group.id, { archivedAt: new Date() })

      const withoutArchived = await listCredentialGroups(db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 50,
      })
      const withArchived = await listCredentialGroups(db(), {
        enabledOnly: false,
        includeArchived: true,
        limit: 50,
      })

      expect(withoutArchived.items.map((item) => item.id)).not.toContain(group.id)
      expect(withArchived.items.map((item) => item.id)).toContain(group.id)
    })

    it('reports the two FR-066 conditions separately, not as one “in use”', async () => {
      const holdsCredential = await seedGroup('store-holds')
      await seedCredential('store-holds-one', holdsCredential.id)

      const attachedGroup = await seedGroup('store-attached')
      const profileId = await seedProfile('store-attached-profile')
      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: attachedGroup.id,
      })

      const holding = await readCredentialGroupReferences(db(), holdsCredential.id)
      const attached = await readCredentialGroupReferences(db(), attachedGroup.id)

      // Different problems with different fixes: one is solved by editing a profile, the other by
      // moving or archiving a credential. The sweep keeps them apart so the refusal can too.
      expect(holding).toMatchObject({ credentialCount: 1, deletable: false })
      expect(holding.attachedProfiles).toStrictEqual([])

      expect(attached).toMatchObject({ credentialCount: 0, deletable: false })
      expect(attached.attachedProfiles).toStrictEqual([
        {
          executionProfileId: profileId,
          name: `store-attached-profile-${fixtures.suffix}`,
          position: 1,
        },
      ])
    })

    it('reports an empty, unattached group as deletable', async () => {
      const group = await seedGroup('store-empty')

      await expect(readCredentialGroupReferences(db(), group.id)).resolves.toStrictEqual({
        credentialCount: 0,
        attachedProfiles: [],
        liveLeaseCount: 0,
        deletable: true,
      })
    })

    it('counts an archived credential as a reference, because the foreign key still points here', async () => {
      const group = await seedGroup('store-archived-member')
      const credentialId = await seedCredential('store-archived-member-one', group.id)
      await updateAgentCredential(db(), credentialId, { archivedAt: new Date() })

      // The list count treats archived members as gone — they are not capacity — but deletion
      // cannot, or the group would be reported deletable and then fail on the constraint.
      const page = await listCredentialGroups(db(), {
        enabledOnly: false,
        includeArchived: false,
        limit: 100,
      })
      expect(page.items.find((item) => item.id === group.id)?.credentialCount).toBe(0)

      const references = await readCredentialGroupReferences(db(), group.id)
      expect(references).toMatchObject({ credentialCount: 1, deletable: false })
    })
  })

  describe('agent credentials', () => {
    it('moves a credential between groups, keeping it in exactly one (FR-061)', async () => {
      const from = await seedGroup('store-move-from')
      const to = await seedGroup('store-move-to')
      const credentialId = await seedCredential('store-move', from.id)

      const moved = await updateAgentCredential(db(), credentialId, { credentialGroupId: to.id })

      expect(moved?.credentialGroupId).toBe(to.id)
      await expect(findAgentCredential(db(), credentialId)).resolves.toMatchObject({
        credentialGroupId: to.id,
      })
    })

    it('offers no way to write state, fence, held_by or secret_id', () => {
      // Those four move only under the leasing protocol's conditional update. A general setter
      // reaching them is a path by which a panel request could overwrite a live claim, which is the
      // double-use this feature exists to prevent — so the *type* forbids it rather than a comment.
      const fields: Parameters<typeof updateAgentCredential>[2] = {}
      expect(Object.keys(fields)).toStrictEqual([])

      // @ts-expect-error `state` is not an administrable field.
      const withState: Parameters<typeof updateAgentCredential>[2] = { state: 'available' }
      // @ts-expect-error `fence` only ever moves with an acquisition.
      const withFence: Parameters<typeof updateAgentCredential>[2] = { fence: 7 }
      // @ts-expect-error `heldBy` is written by whichever claimant won the conditional update.
      const withHolder: Parameters<typeof updateAgentCredential>[2] = { heldBy: 'workflow' }
      // @ts-expect-error `secretId` is written by the login flow, never by an administrator.
      const withSecret: Parameters<typeof updateAgentCredential>[2] = { secretId: 'arn:aws:x' }

      expect([withState, withFence, withHolder, withSecret]).toHaveLength(4)
    })

    it('reports zero live leases for a group nothing is holding', async () => {
      const group = await seedGroup('store-unleased')
      await seedCredential('store-unleased-one', group.id)

      await expect(countLiveLeasesInGroup(db(), group.id)).resolves.toBe(0)
    })

    it('counts a live lease and stops counting it once released (FR-006 group-wide)', async () => {
      const group = await seedGroup('store-leased')
      const credentialId = await seedCredential('store-leased-one', group.id)
      const workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: 'running' })

      const [lease] = await db()
        .insert(credentialLeases)
        .values({ agentCredentialId: credentialId, workflowId, fence: 1 })
        .returning({ id: credentialLeases.id })

      await expect(countLiveLeasesInGroup(db(), group.id)).resolves.toBe(1)

      await db()
        .update(credentialLeases)
        .set({ releasedAt: new Date(), releaseReason: 'terminal' })
        .where(eq(credentialLeases.id, lease.id))

      // `released_at is null` is the same predicate the exclusivity index is partial on, so the
      // count and the index cannot disagree about what "live" means.
      await expect(countLiveLeasesInGroup(db(), group.id)).resolves.toBe(0)
    })

    it('counts every lease a credential has ever had, released or not (FR-005)', async () => {
      const group = await seedGroup('store-history')
      const credentialId = await seedCredential('store-history-one', group.id)
      const workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: 'running' })

      const [lease] = await db()
        .insert(credentialLeases)
        .values({ agentCredentialId: credentialId, workflowId, fence: 1 })
        .returning({ id: credentialLeases.id })

      await expect(countLeasesForCredential(db(), credentialId)).resolves.toBe(1)
      await expect(countLiveLeasesForCredential(db(), credentialId)).resolves.toBe(1)

      await db()
        .update(credentialLeases)
        .set({ releasedAt: new Date(), releaseReason: 'terminal' })
        .where(eq(credentialLeases.id, lease.id))

      // The two counts part company here, and that difference is FR-005: the seat is free, and it
      // is still undeletable, because a finished run's record of what identity it worked as reaches
      // through this row.
      await expect(countLeasesForCredential(db(), credentialId)).resolves.toBe(1)
      await expect(countLiveLeasesForCredential(db(), credentialId)).resolves.toBe(0)
    })

    /**
     * The live lease **named**, which is what a force-release needs and a count cannot give it
     * (FR-057). Half of what FR-057 asks for is resolving the affected run, and a caller that
     * learned only that "somebody" holds the seat would have to find the run somewhere else — with
     * the failure mode being that it ends the wrong one.
     */
    it('names the run holding a seat, and stops naming it once the lease is released', async () => {
      const group = await seedGroup('store-live-lease')
      const credentialId = await seedCredential('store-live-lease-one', group.id)
      const workflowId = await fixtures.seedWorkflow({ ownerUserId: admin.id, state: 'running' })

      await expect(findLiveLeaseForCredential(db(), credentialId)).resolves.toBeUndefined()

      const [lease] = await db()
        .insert(credentialLeases)
        .values({ agentCredentialId: credentialId, workflowId, fence: 3 })
        .returning({ id: credentialLeases.id })

      const live = await findLiveLeaseForCredential(db(), credentialId)
      expect(live).toMatchObject({ leaseId: lease.id, workflowId, fence: 3 })

      await db()
        .update(credentialLeases)
        .set({ releasedAt: new Date(), releaseReason: 'forced' })
        .where(eq(credentialLeases.id, lease.id))

      // The same `released_at is null` predicate `credential_leases_live_key` is partial on, so
      // "the live lease" here and "the one live lease the index permits" are one claim.
      await expect(findLiveLeaseForCredential(db(), credentialId)).resolves.toBeUndefined()
    })
  })

  /**
   * The selection predicate — the one definition of "this seat may be handed to a run".
   *
   * Every case below is a way a credential can look usable and not be, and each is asserted against
   * `listSelectableCredentials` rather than against the row's own columns. That is the whole point:
   * the requirement is a claim about the set a selector can see, so the set is what is asked. A
   * suite that checked `state` and `enabled` by hand would be re-implementing the predicate it is
   * supposed to be testing, and would agree with it by construction.
   */
  describe('selection candidates', () => {
    /** A seat that has been through a login: `available`, with a secret against it. */
    const seedAvailable = async (label: string, credentialGroupId: string): Promise<string> => {
      const credentialId = await seedCredential(label, credentialGroupId)
      await recordAgentCredentialLogin(db(), credentialId, {
        secretId: `arn:aws:secretsmanager:::secret:${label}`,
        lastLoginAt: new Date(),
      })
      return credentialId
    }

    it('offers a logged-in, enabled seat in an enabled group', async () => {
      const group = await seedGroup('store-selectable')
      const credentialId = await seedAvailable('store-selectable-one', group.id)

      await expect(
        listSelectableCredentials(db(), [group.id]).then((rows) => rows.map((row) => row.id)),
      ).resolves.toStrictEqual([credentialId])
    })

    it('withholds one still awaiting a login (FR-008)', async () => {
      const group = await seedGroup('store-awaiting')
      await seedCredential('store-awaiting-one', group.id)

      await expect(listSelectableCredentials(db(), [group.id])).resolves.toStrictEqual([])
    })

    it('withholds one whose state says available but whose secret is null', async () => {
      const group = await seedGroup('store-no-secret')
      const credentialId = await seedCredential('store-no-secret-one', group.id)

      // The state and the secret are deliberately redundant conditions, and this is the failure
      // that redundancy exists for: a state written without its material. Handing this seat out
      // would produce an agent with nothing to authenticate with, on a paid instance.
      await db()
        .update(agentCredentials)
        .set({ state: 'available' })
        .where(eq(agentCredentials.id, credentialId))

      await expect(listSelectableCredentials(db(), [group.id])).resolves.toStrictEqual([])
    })

    it('withholds a disabled seat, and an archived one (FR-005, FR-006)', async () => {
      const group = await seedGroup('store-withheld')
      const disabledId = await seedAvailable('store-withheld-disabled', group.id)
      const archivedId = await seedAvailable('store-withheld-archived', group.id)

      await updateAgentCredential(db(), disabledId, { enabled: false })
      await updateAgentCredential(db(), archivedId, { archivedAt: new Date() })

      await expect(listSelectableCredentials(db(), [group.id])).resolves.toStrictEqual([])
    })

    it('withholds every member of a disabled or deleted group (FR-006 group-wide, FR-066)', async () => {
      const disabled = await seedGroup('store-group-disabled')
      const archived = await seedGroup('store-group-archived')
      await seedAvailable('store-group-disabled-one', disabled.id)
      await seedAvailable('store-group-archived-one', archived.id)

      await updateCredentialGroup(db(), disabled.id, { enabled: false })
      await updateCredentialGroup(db(), archived.id, { archivedAt: new Date() })

      await expect(
        listSelectableCredentials(db(), [disabled.id, archived.id]),
      ).resolves.toStrictEqual([])
    })

    it('orders least-recently-used first, with a never-used seat at the front (FR-034)', async () => {
      const group = await seedGroup('store-lru')
      const never = await seedAvailable('store-lru-never', group.id)
      const older = await seedAvailable('store-lru-older', group.id)
      const newer = await seedAvailable('store-lru-newer', group.id)

      await db()
        .update(agentCredentials)
        .set({ lastUsedAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(agentCredentials.id, older))
      await db()
        .update(agentCredentials)
        .set({ lastUsedAt: new Date('2026-06-01T00:00:00Z') })
        .where(eq(agentCredentials.id, newer))

      // A seat nobody has ever used is the least recently used one, which is why the ordering puts
      // nulls first rather than leaving them wherever the sort happens to drop them.
      await expect(
        listSelectableCredentials(db(), [group.id]).then((rows) => rows.map((row) => row.id)),
      ).resolves.toStrictEqual([never, older, newer])
    })

    it('selects nothing for a profile with no attached groups', async () => {
      // The correct answer for a profile that may draw on nothing, rather than a reason to fall
      // back to the whole platform's capacity.
      await expect(listSelectableCredentials(db(), [])).resolves.toStrictEqual([])
    })

    it('refuses to record a login over a credential that is not awaiting one', async () => {
      const group = await seedGroup('store-adopt-guard')
      const credentialId = await seedAvailable('store-adopt-guard-one', group.id)

      // The conditional is what stops a seat a run is holding being flipped back to `available`
      // and handed to a second run — see the function's own note. `available` is not a state a
      // login completes from either: that seat already works, and replacing its material would
      // invalidate the copy the pool is about to hand out.
      await expect(
        recordAgentCredentialLogin(db(), credentialId, {
          secretId: 'arn:aws:secretsmanager:::secret:replacement',
          lastLoginAt: new Date(),
        }),
      ).resolves.toBeUndefined()

      await expect(findAgentCredential(db(), credentialId)).resolves.toMatchObject({
        secretId: 'arn:aws:secretsmanager:::secret:store-adopt-guard-one',
      })
    })
  })

  describe('profile attachments', () => {
    it('appends each attachment at the end of the preference order (FR-062)', async () => {
      const profileId = await seedProfile('store-order')
      const first = await seedGroup('store-order-first')
      const second = await seedGroup('store-order-second')

      const a = await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: first.id,
      })
      const b = await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: second.id,
      })

      expect(a?.position).toBe(1)
      expect(b?.position).toBe(2)
      await expect(namesFor(profileId)).resolves.toStrictEqual([first.name, second.name])
    })

    it('reports a repeated attachment as already attached rather than failing', async () => {
      const profileId = await seedProfile('store-duplicate')
      const group = await seedGroup('store-duplicate-group')

      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: group.id,
      })

      await expect(
        attachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: group.id,
        }),
      ).resolves.toBeUndefined()

      await expect(positionsFor(profileId)).resolves.toStrictEqual([1])
    })

    it('carries the group’s enabled flag onto the attachment', async () => {
      const profileId = await seedProfile('store-flagged')
      const group = await seedGroup('store-flagged-group')
      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: group.id,
      })
      await updateCredentialGroup(db(), group.id, { enabled: false })

      // A profile whose only attached group is disabled has capacity on paper and none in
      // practice; an editor without this flag could not tell the two apart.
      const attachments = await readProfileCredentialGroups(db(), profileId)
      expect(attachments[0]).toMatchObject({ enabled: false })
    })

    /**
     * **The test this module exists for.** A reversal moves every row onto a position another row
     * currently occupies, so any implementation that assigns final positions directly — in one
     * multi-row `UPDATE` or in a loop — collides with `profile_credential_groups_position_key`
     * partway through, whatever order the executor happens to pick. Passing means the park pass
     * really did vacate every slot before any final position was written.
     */
    it('reverses four attachments without the position index ever being violated', async () => {
      const profileId = await seedProfile('store-reverse')
      const groups = [
        await seedGroup('store-reverse-1'),
        await seedGroup('store-reverse-2'),
        await seedGroup('store-reverse-3'),
        await seedGroup('store-reverse-4'),
      ]

      for (const group of groups) {
        await attachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: group.id,
        })
      }

      const reversed = await reorderCredentialGroups(
        db(),
        profileId,
        [...groups].reverse().map((group) => group.id),
      )

      expect(reversed.map((row) => row.name)).toStrictEqual(
        [...groups].reverse().map((group) => group.name),
      )
      expect(reversed.map((row) => row.position)).toStrictEqual([1, 2, 3, 4])
    })

    it('survives a rotation, the case a one-slot shift gets wrong', async () => {
      const profileId = await seedProfile('store-rotate')
      const groups = [
        await seedGroup('store-rotate-1'),
        await seedGroup('store-rotate-2'),
        await seedGroup('store-rotate-3'),
      ]

      for (const group of groups) {
        await attachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: group.id,
        })
      }

      // 1,2,3 → 2,3,1. Every row moves; two of them move into a slot still occupied when the
      // statement begins.
      const rotated = await reorderCredentialGroups(db(), profileId, [
        groups[1].id,
        groups[2].id,
        groups[0].id,
      ])

      expect(rotated.map((row) => row.name)).toStrictEqual([
        groups[1].name,
        groups[2].name,
        groups[0].name,
      ])
      expect(rotated.map((row) => row.position)).toStrictEqual([1, 2, 3])
    })

    it('leaves the order untouched when the requested order is the current one', async () => {
      const profileId = await seedProfile('store-noop-order')
      const groups = [await seedGroup('store-noop-1'), await seedGroup('store-noop-2')]

      for (const group of groups) {
        await attachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: group.id,
        })
      }

      const same = await reorderCredentialGroups(
        db(),
        profileId,
        groups.map((group) => group.id),
      )

      expect(same.map((row) => row.position)).toStrictEqual([1, 2])
      expect(same.map((row) => row.name)).toStrictEqual(groups.map((group) => group.name))
    })

    it('closes the gap when a middle attachment is detached', async () => {
      const profileId = await seedProfile('store-detach')
      const groups = [
        await seedGroup('store-detach-1'),
        await seedGroup('store-detach-2'),
        await seedGroup('store-detach-3'),
      ]

      for (const group of groups) {
        await attachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: group.id,
        })
      }

      const remaining = await detachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: groups[1].id,
      })

      // Contiguous, so "second preference" still means the second thing tried.
      expect(remaining?.map((row) => row.position)).toStrictEqual([1, 2])
      expect(remaining?.map((row) => row.name)).toStrictEqual([groups[0].name, groups[2].name])

      // And a subsequent attach lands at 3, not at 4 — which it would if the gap had been left.
      const appended = await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: (await seedGroup('store-detach-4')).id,
      })
      expect(appended?.position).toBe(3)
    })

    it('reports a detach of something that was never attached rather than renumbering', async () => {
      const profileId = await seedProfile('store-detach-absent')
      const attached = await seedGroup('store-detach-absent-attached')
      const other = await seedGroup('store-detach-absent-other')

      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: attached.id,
      })

      await expect(
        detachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: other.id,
        }),
      ).resolves.toBeUndefined()

      await expect(positionsFor(profileId)).resolves.toStrictEqual([1])
    })

    it('keeps one profile’s order out of another’s', async () => {
      const mine = await seedProfile('store-scoped-mine')
      const theirs = await seedProfile('store-scoped-theirs')
      const shared = await seedGroup('store-scoped-shared')
      const extra = await seedGroup('store-scoped-extra')

      await attachCredentialGroup(db(), {
        executionProfileId: mine,
        credentialGroupId: shared.id,
      })
      await attachCredentialGroup(db(), {
        executionProfileId: theirs,
        credentialGroupId: extra.id,
      })
      await attachCredentialGroup(db(), {
        executionProfileId: theirs,
        credentialGroupId: shared.id,
      })

      await reorderCredentialGroups(db(), theirs, [shared.id, extra.id])

      // The park pass rewrites every row of the profile it was given and no row of any other, so a
      // reorder cannot renumber a profile the administrator was not editing.
      await expect(namesFor(mine)).resolves.toStrictEqual([shared.name])
      await expect(namesFor(theirs)).resolves.toStrictEqual([shared.name, extra.name])
    })

    it('rolls the whole renumber back with its transaction', async () => {
      const profileId = await seedProfile('store-rollback')
      const groups = [await seedGroup('store-rollback-1'), await seedGroup('store-rollback-2')]

      for (const group of groups) {
        await attachCredentialGroup(db(), {
          executionProfileId: profileId,
          credentialGroupId: group.id,
        })
      }

      await expect(
        db().transaction(async (tx) => {
          await reorderCredentialGroups(
            tx,
            profileId,
            [...groups].reverse().map((group) => group.id),
          )
          throw new Error('the surrounding change failed')
        }),
      ).rejects.toThrow('the surrounding change failed')

      // Nothing here commits on its own: every statement runs on the writer it was handed, so a
      // failed audit write takes the reorder with it rather than leaving a half-applied order.
      await expect(namesFor(profileId)).resolves.toStrictEqual(groups.map((group) => group.name))
    })

    it('finds a group by id and reports a missing one as undefined', async () => {
      const group = await seedGroup('store-find')

      await expect(findCredentialGroup(db(), group.id)).resolves.toMatchObject({ id: group.id })
      await expect(findCredentialGroup(db(), randomUUID())).resolves.toBeUndefined()
      await expect(findAgentCredential(db(), randomUUID())).resolves.toBeUndefined()
    })

    it('writes exactly one row per attachment, so a profile cannot double its own capacity', async () => {
      const profileId = await seedProfile('store-single-row')
      const group = await seedGroup('store-single-row-group')

      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: group.id,
      })
      await attachCredentialGroup(db(), {
        executionProfileId: profileId,
        credentialGroupId: group.id,
      })

      const rows = await db()
        .select({ id: profileCredentialGroups.id })
        .from(profileCredentialGroups)
        .where(
          and(
            eq(profileCredentialGroups.executionProfileId, profileId),
            eq(profileCredentialGroups.credentialGroupId, group.id),
          ),
        )

      expect(rows).toHaveLength(1)
    })
  })

  describe('the material rule', () => {
    it('exposes no read that could return credential material', async () => {
      const group = await seedGroup('store-no-material')
      const credentialId = await seedCredential('store-no-material-one', group.id)

      // `secret_id` is a Secrets Manager *name*; the material behind it is fetched by the machine
      // surface and never by this module (FR-011). The credential row itself is the widest thing
      // this store returns, and it carries a null identifier and nothing else.
      const credential = await findAgentCredential(db(), credentialId)

      expect(credential?.secretId).toBeNull()
      expect(Object.keys(credential ?? {})).not.toContain('secret')
      expect(Object.keys(credential ?? {})).not.toContain('material')
    })
  })
})
