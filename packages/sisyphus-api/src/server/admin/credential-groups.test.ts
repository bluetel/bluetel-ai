import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { agentCredentials, configurationAudit, executionProfiles } from '../../db'
import type { UserRole } from '../../enums'
import type { AuthorisationDenial, SisyphusContext, SisyphusSession } from '../context'
import { createCallerFactory } from '../procedures'
import { memoiseScope } from '../scope'

import {
  credentialGroupNotDeletableError,
  credentialGroupsRouter,
  credentialTargetNotFoundError,
} from './credential-groups'
import { createUserFixtures, readTestDatabaseUrl } from './test-database'

/**
 * The contract test for `admin.credentialGroups` (T019, FR-060..FR-067).
 *
 * Written before the router existed, against the interface data-model.md and
 * contracts/credential-lifecycle.md already fix. Four things are load-bearing here and the rest is
 * bookkeeping around them:
 *
 * 1. **The FR-066 refusal names which condition applies.** Attached-to-a-profile and
 *    holds-a-credential are different problems with different fixes, and a generic "in use" is the
 *    defect this wording exists to prevent — so the assertions are on the sentence, not on the code.
 * 2. **The order is a permutation at every instant.** A reversal and a rotation both move every row
 *    onto a slot another row occupies; `profile_credential_groups_position_key` cannot be deferred,
 *    so an implementation that assigns final positions directly fails these against a real Postgres
 *    and passes against anything else. That is why this suite is database-backed rather than mocked.
 * 3. **FR-065 holds after configuration, not just during it.** A profile made launchable and then
 *    stripped of its last group would fail at admission, which is exactly what the requirement
 *    forbids — so detaching the last usable attachment from an enabled profile is refused here.
 * 4. **A non-administrator is refused and the refusal is recorded** (FR-004, FR-067, SC-013).
 */

/**
 * The refusal a call produced.
 *
 * Used instead of `expect.stringContaining` inside `toMatchObject`, which is typed `any` and so
 * turns a message assertion into an unchecked one — and this suite's whole point is what the
 * messages say.
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
    },
    db,
    session,
    scope: memoiseScope(() =>
      Promise.resolve({ userId: user.id, isAdmin: user.role === 'admin', visibleProfileIds: [] }),
    ),
    machineCredential: () => Promise.resolve(null),
  }
}

describe('the admin.credentialGroups contract', () => {
  it('exposes exactly the procedures this story needs, and no more', () => {
    expect(Object.keys(credentialGroupsRouter._def.procedures).sort()).toStrictEqual([
      'attach',
      'create',
      'delete',
      'detach',
      'forProfile',
      'list',
      'moveCredential',
      'references',
      'rename',
      'reorder',
      'setEnabled',
    ])
  })

  it('makes the reads queries and every write a mutation', () => {
    const procedures = credentialGroupsRouter._def.procedures
    for (const name of ['list', 'references', 'forProfile'] as const) {
      expect(procedures[name]._def.type).toBe('query')
    }
    for (const name of [
      'create',
      'rename',
      'setEnabled',
      'delete',
      'moveCredential',
      'attach',
      'detach',
      'reorder',
    ] as const) {
      expect(procedures[name]._def.type).toBe('mutation')
    }
  })
})

describe('credentialTargetNotFoundError', () => {
  it('is NOT_FOUND, never FORBIDDEN — FORBIDDEN would confirm the id exists (FR-190)', () => {
    expect(credentialTargetNotFoundError().code).toBe('NOT_FOUND')
  })

  it('does not say which of the three ids was the missing one', () => {
    expect(credentialTargetNotFoundError().message).toBe(
      'No such credential group, agent credential or execution profile.',
    )
  })
})

/**
 * FR-066's refusal, asserted as a pure function so the wording is pinned independently of whether a
 * database is available. **This is the requirement's actual content**: not that deletion is refused,
 * but that the administrator is told which of the two conditions they are up against.
 */
describe('credentialGroupNotDeletableError', () => {
  it('names holding a credential, and says what to do about it', () => {
    const refusal = credentialGroupNotDeletableError(
      { name: 'vendor pool' },
      { credentialCount: 3, attachedProfiles: [] },
    )

    expect(refusal.code).toBe('CONFLICT')
    expect(refusal.message).toContain('vendor pool')
    expect(refusal.message).toContain('holds 3 agent credentials')
    expect(refusal.message).toContain('move them to another group or archive them first')
    // The other condition does not hold, so it is not mentioned — an administrator sent looking
    // through profiles for an attachment that does not exist has been actively misled.
    expect(refusal.message).not.toContain('attached to the execution')
  })

  it('names the attached profiles, and says where to detach them', () => {
    const refusal = credentialGroupNotDeletableError(
      { name: 'vendor pool' },
      {
        credentialCount: 0,
        attachedProfiles: [
          { executionProfileId: randomUUID(), name: 'platform', position: 1 },
          { executionProfileId: randomUUID(), name: 'client-work', position: 2 },
        ],
      },
    )

    expect(refusal.message).toContain('attached to the execution profiles platform, client-work')
    expect(refusal.message).toContain('detach it there first')
    expect(refusal.message).not.toContain('agent credential')
  })

  it('states both conditions when both apply, rather than picking one', () => {
    const refusal = credentialGroupNotDeletableError(
      { name: 'vendor pool' },
      {
        credentialCount: 1,
        attachedProfiles: [{ executionProfileId: randomUUID(), name: 'platform', position: 1 }],
      },
    )

    expect(refusal.message).toContain('holds 1 agent credential')
    expect(refusal.message).toContain('attached to the execution profile platform')
  })

  it('always names disabling as the way forward (FR-066)', () => {
    // FR-066's shape is "not deletable, disableable instead". A refusal that stopped at "no" would
    // leave an administrator with a group they can neither remove nor withdraw from selection.
    const refusal = credentialGroupNotDeletableError(
      { name: 'vendor pool' },
      { credentialCount: 1, attachedProfiles: [] },
    )

    expect(refusal.message).toContain('Disable it instead')
    expect(refusal.message).toContain('without interrupting any run currently holding one')
  })
})

const liveDatabaseUrl = readTestDatabaseUrl()

describe.skipIf(liveDatabaseUrl === undefined)(
  'admin.credentialGroups against a live database',
  () => {
    const fixtures = createUserFixtures(liveDatabaseUrl ?? '')
    const denials: AuthorisationDenial[] = []

    let admin: CallerIdentity
    let engineer: CallerIdentity

    const createCaller = createCallerFactory(credentialGroupsRouter)
    const asAdmin = () => createCaller(contextFor(fixtures.db(), admin, denials))
    const asEngineer = () => createCaller(contextFor(fixtures.db(), engineer, denials))

    const named = (label: string) => `${label}-${fixtures.suffix}`

    const createGroup = async (label: string) => asAdmin().create({ name: named(label) })

    /**
     * A profile with no version, which is all an attachment needs.
     *
     * Inserted directly rather than through `admin.profiles.create`: attachments hang off the
     * mutable profile row and not off a version, so reaching for the profile router to build this
     * fixture would make a failure there look like one here.
     */
    const createProfile = async (label: string, enabled = false): Promise<string> => {
      const [profile] = await fixtures
        .db()
        .insert(executionProfiles)
        .values({ name: named(label), enabled })
        .returning({ id: executionProfiles.id })
      return profile.id
    }

    const registerCredential = async (
      label: string,
      credentialGroupId: string,
    ): Promise<string> => {
      const [credential] = await fixtures
        .db()
        .insert(agentCredentials)
        .values({
          credentialGroupId,
          name: named(label),
          state: 'awaiting_login',
          createdByUserId: admin.id,
        })
        .returning({ id: agentCredentials.id })
      return credential.id
    }

    const trailFor = async (entityId: string) =>
      fixtures
        .db()
        .select()
        .from(configurationAudit)
        .where(
          and(
            inArray(configurationAudit.entityType, ['credential_group', 'agent_credential']),
            eq(configurationAudit.entityId, entityId),
          ),
        )
        .orderBy(configurationAudit.createdAt)

    const orderFor = async (executionProfileId: string): Promise<readonly string[]> =>
      (await asAdmin().forProfile({ executionProfileId })).attachments.map(
        (attachment) => attachment.name,
      )

    beforeAll(async () => {
      await fixtures.open()
      const seededAdmin = await fixtures.seedUser({ label: 'credential-admin', role: 'admin' })
      const seededEngineer = await fixtures.seedUser({ label: 'credential-engineer' })
      admin = { ...seededAdmin, role: 'admin' }
      engineer = { ...seededEngineer, role: 'engineer' }
    }, 60_000)

    afterAll(async () => {
      await fixtures.close()
    }, 30_000)

    describe('who may act (FR-004, FR-067)', () => {
      it('refuses every procedure to a non-administrator and records each denial', async () => {
        denials.length = 0
        const caller = asEngineer()

        await expect(caller.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
        await expect(caller.create({ name: named('smuggled') })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        })
        await expect(
          caller.setEnabled({ credentialGroupId: randomUUID(), enabled: false }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
        await expect(caller.delete({ credentialGroupId: randomUUID() })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        })
        await expect(
          caller.attach({
            executionProfileId: randomUUID(),
            credentialGroupId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
        await expect(
          caller.reorder({
            executionProfileId: randomUUID(),
            credentialGroupIds: [randomUUID()],
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })

        // SC-013: the refusal is a fact somebody may need afterwards, so it is recorded rather
        // than merely returned. Credential configuration is admin-only even for reads
        // (data-model.md → Access scoping), which is why `list` is in this list too.
        expect(denials).toHaveLength(6)
        expect(new Set(denials.map((denial) => denial.reason))).toStrictEqual(
          new Set(['not_admin']),
        )
        expect(denials.map((denial) => denial.path).sort()).toStrictEqual([
          'attach',
          'create',
          'delete',
          'list',
          'reorder',
          'setEnabled',
        ])
      })

      it('refuses the reads too — a credential’s state tells an engineer nothing they can act on', async () => {
        denials.length = 0

        await expect(
          asEngineer().forProfile({ executionProfileId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
        await expect(
          asEngineer().references({ credentialGroupId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })

        expect(denials).toHaveLength(2)
      })
    })

    describe('create, rename, disable (FR-060, FR-067)', () => {
      it('creates a group enabled, and records the acting administrator', async () => {
        const group = await asAdmin().create({
          name: named('alpha'),
          description: 'The vendor pool.',
        })

        expect(group.enabled).toBe(true)
        expect(group.archivedAt).toBeNull()
        expect(group.description).toBe('The vendor pool.')

        const trail = await trailFor(group.id)
        expect(trail).toHaveLength(1)
        expect(trail[0]).toMatchObject({
          entityType: 'credential_group',
          action: 'registered',
          actorUserId: admin.id,
        })
      })

      it('refuses a duplicate name, case-insensitively, because citext says they are one name', async () => {
        await expect(asAdmin().create({ name: named('ALPHA') })).rejects.toMatchObject({
          code: 'CONFLICT',
        })
      })

      it('renames a group and records what it used to be called', async () => {
        const group = await createGroup('to-rename')
        const renamed = await asAdmin().rename({
          credentialGroupId: group.id,
          name: named('renamed'),
        })

        expect(renamed.name).toBe(named('renamed'))

        // Without the previous name, every earlier entry in the trail names a group that no longer
        // answers to that name, and the history stops being joinable.
        const trail = await trailFor(group.id)
        expect(trail.at(-1)).toMatchObject({ action: 'updated', actorUserId: admin.id })
        expect(trail.at(-1)?.detail).toMatchObject({ previousName: named('to-rename') })
      })

      it('refuses a rename onto another group’s name', async () => {
        const group = await createGroup('rename-clash')

        await expect(
          asAdmin().rename({ credentialGroupId: group.id, name: named('alpha') }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
      })

      it('disables a group, reporting how many runs it is not interrupting (FR-006)', async () => {
        const group = await createGroup('to-disable')

        const disabled = await asAdmin().setEnabled({
          credentialGroupId: group.id,
          enabled: false,
        })

        expect(disabled.group.enabled).toBe(false)
        expect(disabled.liveHolderCount).toBe(0)

        const trail = await trailFor(group.id)
        expect(trail.at(-1)).toMatchObject({ action: 'disabled', actorUserId: admin.id })
      })

      it('writes no audit entry for a disable that changes nothing', async () => {
        const group = await createGroup('already-disabled')
        await asAdmin().setEnabled({ credentialGroupId: group.id, enabled: false })
        const before = (await trailFor(group.id)).length

        await asAdmin().setEnabled({ credentialGroupId: group.id, enabled: false })

        expect(await trailFor(group.id)).toHaveLength(before)
      })

      it('re-enables a group it disabled', async () => {
        const group = await createGroup('to-re-enable')
        await asAdmin().setEnabled({ credentialGroupId: group.id, enabled: false })

        const enabled = await asAdmin().setEnabled({
          credentialGroupId: group.id,
          enabled: true,
        })

        expect(enabled.group.enabled).toBe(true)
        expect((await trailFor(group.id)).at(-1)).toMatchObject({ action: 'enabled' })
      })

      it('reports an unknown group identically across every procedure (FR-190)', async () => {
        const caller = asAdmin()
        const expected = {
          code: 'NOT_FOUND',
          message: 'No such credential group, agent credential or execution profile.',
        }

        await expect(caller.references({ credentialGroupId: randomUUID() })).rejects.toMatchObject(
          expected,
        )
        await expect(
          caller.rename({ credentialGroupId: randomUUID(), name: named('nowhere') }),
        ).rejects.toMatchObject(expected)
        await expect(
          caller.setEnabled({ credentialGroupId: randomUUID(), enabled: false }),
        ).rejects.toMatchObject(expected)
        await expect(caller.delete({ credentialGroupId: randomUUID() })).rejects.toMatchObject(
          expected,
        )
      })
    })

    describe('the FR-066 delete refusal', () => {
      it('deletes an empty, unattached group as a soft delete', async () => {
        const group = await createGroup('deletable')

        const deleted = await asAdmin().delete({ credentialGroupId: group.id })

        expect(deleted.archivedAt).not.toBeNull()
        expect(deleted.enabled).toBe(false)

        // Archived, not gone: the id appears in the trail, and nothing is repaired by its
        // disappearance.
        const page = await asAdmin().list({ includeArchived: true, limit: 100 })
        expect(page.items.map((item) => item.id)).toContain(group.id)
      })

      it('refuses a group holding a credential, saying so and not saying anything else', async () => {
        const group = await createGroup('holds-credential')
        await registerCredential('member', group.id)

        const refusal = await refusalOf(asAdmin().delete({ credentialGroupId: group.id }))

        expect(refusal.code).toBe('CONFLICT')
        expect(refusal.message).toContain('holds 1 agent credential')
        expect(refusal.message).not.toContain('attached to the execution')
        expect(refusal.message).toContain('Disable it instead')
      })

      it('refuses a group attached to a profile, naming the profile', async () => {
        const group = await createGroup('is-attached')
        const executionProfileId = await createProfile('attached-profile')
        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        const refusal = await refusalOf(asAdmin().delete({ credentialGroupId: group.id }))

        expect(refusal.code).toBe('CONFLICT')
        // The two conditions are fixed in different places, so an administrator must be able to
        // tell from the refusal alone which screen they need.
        expect(refusal.message).toContain(
          `attached to the execution profile ${named('attached-profile')}`,
        )
        expect(refusal.message).not.toContain('agent credential')
      })

      it('names both conditions when both hold', async () => {
        const group = await createGroup('both-conditions')
        await registerCredential('both-member', group.id)
        const executionProfileId = await createProfile('both-profile')
        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        const refusal = await refusalOf(asAdmin().delete({ credentialGroupId: group.id }))

        expect(refusal.message).toContain('holds 1 agent credential')
        expect(refusal.message).toContain(
          `attached to the execution profile ${named('both-profile')}`,
        )
      })

      it('leaves the group untouched when it refuses', async () => {
        const group = await createGroup('refused-intact')
        await registerCredential('refused-member', group.id)

        await refusalOf(asAdmin().delete({ credentialGroupId: group.id }))

        const references = await asAdmin().references({ credentialGroupId: group.id })
        expect(references.deletable).toBe(false)

        const page = await asAdmin().list({ limit: 100 })
        expect(page.items.find((item) => item.id === group.id)?.archivedAt ?? null).toBeNull()
      })

      it('offers disabling as the alternative, and that alternative always works', async () => {
        const group = await createGroup('refused-but-disableable')
        await registerCredential('refused-but-disableable-member', group.id)

        await refusalOf(asAdmin().delete({ credentialGroupId: group.id }))

        // FR-066's other half. If this failed, the refusal above would be a dead end.
        const disabled = await asAdmin().setEnabled({
          credentialGroupId: group.id,
          enabled: false,
        })
        expect(disabled.group.enabled).toBe(false)
      })
    })

    describe('membership (FR-061, FR-067)', () => {
      it('moves a credential into another group, recording both ends', async () => {
        const from = await createGroup('move-from')
        const to = await createGroup('move-to')
        const agentCredentialId = await registerCredential('mover', from.id)

        const moved = await asAdmin().moveCredential({
          agentCredentialId,
          credentialGroupId: to.id,
        })

        expect(moved.fromCredentialGroupId).toBe(from.id)
        expect(moved.toCredentialGroupId).toBe(to.id)
        expect(moved.credential.credentialGroupId).toBe(to.id)

        const trail = await trailFor(agentCredentialId)
        expect(trail.at(-1)).toMatchObject({
          entityType: 'agent_credential',
          action: 'updated',
          actorUserId: admin.id,
        })
        expect(trail.at(-1)?.detail).toMatchObject({
          fromCredentialGroupId: from.id,
          toCredentialGroupId: to.id,
        })
      })

      it('leaves a credential in exactly one group — the move empties the old one', async () => {
        const from = await createGroup('single-from')
        const to = await createGroup('single-to')
        await registerCredential('single-mover', from.id)

        const before = await asAdmin().references({ credentialGroupId: from.id })
        expect(before.credentialCount).toBe(1)

        const [credential] = await fixtures
          .db()
          .select({ id: agentCredentials.id })
          .from(agentCredentials)
          .where(eq(agentCredentials.credentialGroupId, from.id))

        await asAdmin().moveCredential({
          agentCredentialId: credential.id,
          credentialGroupId: to.id,
        })

        // FR-061 is "exactly one group", so the old group must be empty afterwards — and empty
        // means deletable, which is the observable consequence that matters.
        await expect(asAdmin().references({ credentialGroupId: from.id })).resolves.toMatchObject({
          credentialCount: 0,
          deletable: true,
        })
        await expect(asAdmin().references({ credentialGroupId: to.id })).resolves.toMatchObject({
          credentialCount: 1,
        })
      })

      it('writes nothing when the credential is already in that group', async () => {
        const group = await createGroup('same-group')
        const agentCredentialId = await registerCredential('stayer', group.id)
        const before = (await trailFor(agentCredentialId)).length

        const moved = await asAdmin().moveCredential({
          agentCredentialId,
          credentialGroupId: group.id,
        })

        expect(moved.fromCredentialGroupId).toBe(group.id)
        expect(await trailFor(agentCredentialId)).toHaveLength(before)
      })

      it('refuses a move into a deleted group, saying it was deleted rather than that it is missing', async () => {
        const group = await createGroup('deleted-destination')
        const source = await createGroup('live-source')
        const agentCredentialId = await registerCredential('blocked-mover', source.id)
        await asAdmin().delete({ credentialGroupId: group.id })

        const refusal = await refusalOf(
          asAdmin().moveCredential({ agentCredentialId, credentialGroupId: group.id }),
        )

        // An administrator who archived this group last month needs to be told that, not told it
        // never existed.
        expect(refusal.code).toBe('CONFLICT')
        expect(refusal.message).toContain('has been deleted')
      })

      it('refuses a move of a credential that does not exist', async () => {
        const group = await createGroup('move-nowhere')

        await expect(
          asAdmin().moveCredential({
            agentCredentialId: randomUUID(),
            credentialGroupId: group.id,
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })
    })

    describe('ordered attachment (FR-062, FR-064)', () => {
      it('appends each attachment at the end of the preference order', async () => {
        const executionProfileId = await createProfile('ordering')
        const first = await createGroup('order-first')
        const second = await createGroup('order-second')

        await asAdmin().attach({ executionProfileId, credentialGroupId: first.id })
        const after = await asAdmin().attach({
          executionProfileId,
          credentialGroupId: second.id,
        })

        expect(after.attachments.map((attachment) => attachment.position)).toStrictEqual([1, 2])
        await expect(orderFor(executionProfileId)).resolves.toStrictEqual([first.name, second.name])
      })

      it('records an attachment against the group, naming the profile (FR-067)', async () => {
        const executionProfileId = await createProfile('attach-audited')
        const group = await createGroup('attach-audited-group')

        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        const trail = await trailFor(group.id)
        expect(trail.at(-1)).toMatchObject({
          entityType: 'credential_group',
          action: 'granted',
          actorUserId: admin.id,
        })
        expect(trail.at(-1)?.detail).toMatchObject({
          executionProfileId,
          executionProfileName: named('attach-audited'),
          position: 1,
        })
      })

      it('treats a repeated attach as the same request, writing nothing the second time', async () => {
        const executionProfileId = await createProfile('attach-twice')
        const group = await createGroup('attach-twice-group')

        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })
        const before = (await trailFor(group.id)).length
        const again = await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        expect(again.attachments).toHaveLength(1)
        expect(await trailFor(group.id)).toHaveLength(before)
      })

      /**
       * The reordering assertions. A reversal and a rotation both move every row onto a position
       * another row currently holds, and `profile_credential_groups_position_key` is a plain unique
       * index — Postgres checks it as each row is written, with no way to defer it to commit. So an
       * implementation that writes final positions directly fails here, whatever order it picks.
       */
      it('reverses four attachments, keeping the position index satisfied throughout', async () => {
        const executionProfileId = await createProfile('reversing')
        const groups = [
          await createGroup('reverse-1'),
          await createGroup('reverse-2'),
          await createGroup('reverse-3'),
          await createGroup('reverse-4'),
        ]

        for (const group of groups) {
          await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })
        }

        const reordered = await asAdmin().reorder({
          executionProfileId,
          credentialGroupIds: [...groups].reverse().map((group) => group.id),
        })

        expect(reordered.attachments.map((attachment) => attachment.position)).toStrictEqual([
          1, 2, 3, 4,
        ])
        await expect(orderFor(executionProfileId)).resolves.toStrictEqual(
          [...groups].reverse().map((group) => group.name),
        )
      })

      it('rotates an order, the case a one-slot shift gets wrong', async () => {
        const executionProfileId = await createProfile('rotating')
        const groups = [
          await createGroup('rotate-1'),
          await createGroup('rotate-2'),
          await createGroup('rotate-3'),
        ]

        for (const group of groups) {
          await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })
        }

        await asAdmin().reorder({
          executionProfileId,
          credentialGroupIds: [groups[1].id, groups[2].id, groups[0].id],
        })

        await expect(orderFor(executionProfileId)).resolves.toStrictEqual([
          groups[1].name,
          groups[2].name,
          groups[0].name,
        ])
      })

      it('records a reorder with the order it replaced', async () => {
        const executionProfileId = await createProfile('reorder-audited')
        const groups = [
          await createGroup('reorder-audited-1'),
          await createGroup('reorder-audited-2'),
        ]

        for (const group of groups) {
          await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })
        }

        await asAdmin().reorder({
          executionProfileId,
          credentialGroupIds: [groups[1].id, groups[0].id],
        })

        const trail = await trailFor(groups[1].id)
        expect(trail.at(-1)).toMatchObject({ action: 'updated', actorUserId: admin.id })
        expect(trail.at(-1)?.detail).toMatchObject({
          previousOrder: [groups[0].id, groups[1].id],
          order: [groups[1].id, groups[0].id],
        })
      })

      it('refuses an order that is not exactly what is attached', async () => {
        const executionProfileId = await createProfile('stale-order')
        const attached = await createGroup('stale-attached')
        const unattached = await createGroup('stale-unattached')
        await asAdmin().attach({ executionProfileId, credentialGroupId: attached.id })

        // Omitting one, adding one, and repeating one are all the same defect: the panel's list was
        // built from a read that no longer describes the database, and applying the difference
        // would attach or detach on the strength of a stale view.
        for (const credentialGroupIds of [
          [unattached.id],
          [attached.id, unattached.id],
          [attached.id, attached.id],
        ]) {
          const refusal = await refusalOf(
            asAdmin().reorder({ executionProfileId, credentialGroupIds }),
          )
          expect(refusal.code).toBe('CONFLICT')
          expect(refusal.message).toContain('Reload the profile')
        }

        await expect(orderFor(executionProfileId)).resolves.toStrictEqual([attached.name])
      })

      it('detaches a group and closes the gap it leaves', async () => {
        const executionProfileId = await createProfile('detaching')
        const groups = [
          await createGroup('detach-1'),
          await createGroup('detach-2'),
          await createGroup('detach-3'),
        ]

        for (const group of groups) {
          await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })
        }

        const after = await asAdmin().detach({
          executionProfileId,
          credentialGroupId: groups[1].id,
        })

        expect(after.attachments.map((attachment) => attachment.position)).toStrictEqual([1, 2])
        expect(after.attachments.map((attachment) => attachment.name)).toStrictEqual([
          groups[0].name,
          groups[2].name,
        ])

        const trail = await trailFor(groups[1].id)
        expect(trail.at(-1)).toMatchObject({ action: 'revoked', actorUserId: admin.id })
        expect(trail.at(-1)?.detail).toMatchObject({ executionProfileId, previousPosition: 2 })
      })

      it('refuses to detach something that was never attached', async () => {
        const executionProfileId = await createProfile('detach-absent')
        const attached = await createGroup('detach-absent-attached')
        const other = await createGroup('detach-absent-other')
        await asAdmin().attach({ executionProfileId, credentialGroupId: attached.id })

        await expect(
          asAdmin().detach({ executionProfileId, credentialGroupId: other.id }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('refuses an attachment onto a profile that does not exist', async () => {
        const group = await createGroup('attach-nowhere')

        await expect(
          asAdmin().attach({
            executionProfileId: randomUUID(),
            credentialGroupId: group.id,
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      })

      it('keeps one profile’s order out of another’s', async () => {
        const mine = await createProfile('scoped-mine')
        const theirs = await createProfile('scoped-theirs')
        const shared = await createGroup('scoped-shared')
        const extra = await createGroup('scoped-extra')

        await asAdmin().attach({ executionProfileId: mine, credentialGroupId: shared.id })
        await asAdmin().attach({ executionProfileId: theirs, credentialGroupId: extra.id })
        await asAdmin().attach({ executionProfileId: theirs, credentialGroupId: shared.id })

        await asAdmin().reorder({
          executionProfileId: theirs,
          credentialGroupIds: [shared.id, extra.id],
        })

        // SC-016 depends on a profile's attachments being that profile's. A renumber that reached
        // another profile's rows would silently re-order somebody else's preference.
        await expect(orderFor(mine)).resolves.toStrictEqual([shared.name])
        await expect(orderFor(theirs)).resolves.toStrictEqual([shared.name, extra.name])
      })
    })

    /**
     * FR-065's other end. The enable gate (see `profile-gate.test.ts`) refuses to *make* a profile
     * launchable without an attachment; this refuses to take the attachment away afterwards. Without
     * both, the requirement would hold only for profiles nobody had edited since enabling them.
     */
    describe('FR-065 after configuration', () => {
      it('refuses to detach the last group from an enabled profile, naming what would break', async () => {
        const executionProfileId = await createProfile('enabled-profile', true)
        const group = await createGroup('last-group')
        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        const refusal = await refusalOf(
          asAdmin().detach({ executionProfileId, credentialGroupId: group.id }),
        )

        expect(refusal.code).toBe('CONFLICT')
        expect(refusal.message).toContain('unlaunchable')
        expect(refusal.message).toContain('no attached credential group')
        expect(refusal.message).toContain('Attach another credential group first')

        // Refused means refused: the attachment is still there, so the profile is still launchable.
        await expect(orderFor(executionProfileId)).resolves.toStrictEqual([group.name])
      })

      it('allows the detach once another group is attached', async () => {
        const executionProfileId = await createProfile('enabled-with-two', true)
        const first = await createGroup('enabled-with-two-1')
        const second = await createGroup('enabled-with-two-2')
        await asAdmin().attach({ executionProfileId, credentialGroupId: first.id })
        await asAdmin().attach({ executionProfileId, credentialGroupId: second.id })

        const after = await asAdmin().detach({
          executionProfileId,
          credentialGroupId: first.id,
        })

        expect(after.attachments.map((attachment) => attachment.name)).toStrictEqual([second.name])
      })

      it('refuses when the only remaining attachment is a disabled group', async () => {
        const executionProfileId = await createProfile('enabled-with-disabled', true)
        const live = await createGroup('enabled-with-disabled-live')
        const dead = await createGroup('enabled-with-disabled-dead')
        await asAdmin().attach({ executionProfileId, credentialGroupId: live.id })
        await asAdmin().attach({ executionProfileId, credentialGroupId: dead.id })
        await asAdmin().setEnabled({ credentialGroupId: dead.id, enabled: false })

        const refusal = await refusalOf(
          asAdmin().detach({ executionProfileId, credentialGroupId: live.id }),
        )

        // "Has an attachment" and "can select a credential" are different properties; the same
        // check the enable gate runs is what keeps them from drifting apart.
        expect(refusal.message).toContain('unavailable')
      })

      it('lets a disabled profile be stripped to nothing', async () => {
        const executionProfileId = await createProfile('disabled-profile')
        const group = await createGroup('disabled-profile-group')
        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        const after = await asAdmin().detach({ executionProfileId, credentialGroupId: group.id })

        // It cannot launch anything in this state, and the enable gate stands between it and being
        // able to — so refusing here would only force an administrator to attach a group they do
        // not want in order to remove the one they do.
        expect(after.attachments).toStrictEqual([])
      })

      it('never gates disabling a group, even when it leaves an enabled profile unlaunchable', async () => {
        const executionProfileId = await createProfile('disable-consequence', true)
        const group = await createGroup('disable-consequence-group')
        await asAdmin().attach({ executionProfileId, credentialGroupId: group.id })

        // The deliberate asymmetry with `detach`: disabling is the platform's only way to withdraw
        // a broken pool, and an administrator whose credentials have all started failing must not
        // be told they may not withdraw them because a profile still points at them.
        const disabled = await asAdmin().setEnabled({
          credentialGroupId: group.id,
          enabled: false,
        })

        expect(disabled.group.enabled).toBe(false)
        await expect(orderFor(executionProfileId)).resolves.toStrictEqual([group.name])
      })
    })
  },
)
