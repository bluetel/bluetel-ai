import { TRPCError } from '@trpc/server'

import type { AgentCredential, CredentialGroup } from '../../db'
import {
  attachCredentialGroupInput,
  createCredentialGroupInput,
  credentialGroupIdInput,
  detachCredentialGroupInput,
  listCredentialGroupsInput,
  moveCredentialToGroupInput,
  profileCredentialGroupsInput,
  renameCredentialGroupInput,
  reorderCredentialGroupsInput,
  setCredentialGroupEnabledInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import type {
  CredentialGroupListing,
  CredentialGroupReferences,
  ProfileCredentialGroupAttachment,
} from './credential-store'
import {
  attachCredentialGroup,
  countLiveLeasesInGroup,
  detachCredentialGroup,
  findAgentCredential,
  findCredentialGroup,
  findCredentialGroupByName,
  insertCredentialGroup,
  listCredentialGroups,
  readCredentialGroupReferences,
  readProfileCredentialGroups,
  reorderCredentialGroups,
  updateAgentCredential,
  updateCredentialGroup,
} from './credential-store'
import { credentialGroupAttachmentCheck } from './profile-gate'
import { findProfile } from './profile-store'
import type { Page } from './user-queries'

/**
 * `admin.credentialGroups` — the capacity pools agent credentials belong to, and the ordered
 * attachments that decide which execution profiles may draw on them (FR-060..FR-067).
 *
 * ## What a group is for
 *
 * A credential group is how an administrator says "runs launched from these profiles work as one of
 * these identities". Every credential belongs to exactly one group, assigned at registration
 * (FR-061), and a workflow is only ever granted a credential from a group its profile is attached
 * to (FR-063). That single rule is the whole of SC-016 — work launched under a profile is never
 * performed by an identity outside its groups — and it holds because there is no other path from a
 * workflow to a credential, not because anything audits it after the fact.
 *
 * ## Two refusals that must not be one refusal
 *
 * FR-066 refuses to delete a group that is attached to a profile **or** holds a credential. Those
 * are different problems with different fixes and different urgencies: an attachment is undone by
 * editing the profiles named in the refusal, whereas a member credential must be moved into another
 * group or archived first — and a run may be holding it at this moment. A single "this group is in
 * use" would leave the administrator to discover which by trial and error, on a screen that already
 * knows the answer. So {@link credentialGroupNotDeletableError} enumerates the conditions that
 * actually apply, by name, and states both when both apply.
 *
 * ## Attachment is to the profile, not to a profile version
 *
 * `profile_credential_groups.execution_profile_id` points at the **mutable `execution_profiles`
 * row**, deliberately against the pattern 002 uses for every other launch value, and the deviation
 * is worth stating here because a reader who knows 002 will otherwise take it for an oversight.
 *
 * A profile *version* pins what a run **does** — its bundle, its workspace, its model, its caps —
 * and `workflows.execution_profile_version_id` reconstructs exactly that for the retention period.
 * The credential pool is not what a run does; it is capacity the platform draws on, and it changes
 * for operational reasons that have nothing to do with the run's configuration. Pinning attachments
 * to a version would have two consequences, both bad: a historical run could not be re-launched
 * once the pool it drew on had been reorganised, and editing a group attachment — a pure capacity
 * decision — would mint a profile version, presenting itself in the trail as a new way of running.
 * What reconstruction actually needs is which credential a run used, and that is recorded on the run
 * itself (`workflows.agent_credential_id`, FR-059). See data-model.md → `profile_credential_groups`.
 *
 * ## The order is total and contiguous, at every instant
 *
 * Attachments occupy positions `1..n` with no gaps, and `profile_credential_groups_position_key` is
 * a plain unique index — it cannot be deferred to commit, so Postgres checks it as each row is
 * written. Every reorder therefore goes through the store's two-pass renumber, which vacates every
 * slot before any final position is written; see `renumberAttachments` in `credential-store.ts` for
 * why the obvious implementations are wrong in a way that only shows up on the reorders that
 * overlap.
 *
 * ## Everything here is admin-only and everything here is audited
 *
 * FR-067: creating, renaming, disabling or deleting a group, changing its membership, and changing
 * a profile's attachments all require the administrator role and are recorded with the acting
 * administrator — inside the same transaction as the change, so a trail entry cannot survive a
 * change that rolled back (FR-004, SC-013). Credential configuration is admin-only even where 002
 * would have scoped it to a profile's grantees: a credential is platform infrastructure and its
 * state tells an engineer nothing they can act on (data-model.md → Access scoping).
 */

/**
 * The one refusal for a group, credential or profile this router cannot act on.
 *
 * `NOT_FOUND` rather than `FORBIDDEN`, and singular across the three, for the same reason
 * `grantTargetNotFoundError` and `profileTargetNotFoundError` are: a refusal that distinguished them
 * would answer "does this id exist?" for ids the caller has not been shown (FR-190).
 */
export const credentialTargetNotFoundError = (): TRPCError =>
  new TRPCError({
    code: 'NOT_FOUND',
    message: 'No such credential group, agent credential or execution profile.',
  })

/** Refusal for a name already taken. The name is the caller's own input, so echoing it leaks nothing. */
export const duplicateCredentialGroupNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `A credential group named ${name} already exists. Rename that one, or add credentials to it.`,
  })

/**
 * Refusal for a group or attachment that exists but cannot be acted on in its current state.
 *
 * `CONFLICT` because the request is well-formed and the caller is entitled to make it — what is
 * wrong is the state of what they are pointing at. Safe to name that state: every caller here is an
 * administrator, who may already see every group on the platform (FR-053).
 */
export const credentialGroupStateError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/**
 * FR-066's refusal, naming **which** condition applies.
 *
 * The two conditions are stated separately, and both are stated when both hold, because they are
 * fixed in different places. "This group is in use" would be true, unhelpful, and would send an
 * administrator looking through profiles for an attachment that does not exist when what they
 * actually have is a credential still filed under the group.
 *
 * The credential count deliberately includes archived credentials: `agent_credentials
 * .credential_group_id` is a foreign key that an archived row still holds, so a delete would fail on
 * the constraint anyway, and refusing honestly is better than reporting the group as deletable and
 * then surfacing a driver error.
 *
 * `enabled = false` is always the alternative and the message says so, because FR-066's whole shape
 * is "not deletable, disableable instead" — a refusal that did not name the way forward would leave
 * the administrator with a group they can neither remove nor withdraw.
 */
export const credentialGroupNotDeletableError = (
  group: Pick<CredentialGroup, 'name'>,
  references: Pick<CredentialGroupReferences, 'credentialCount' | 'attachedProfiles'>,
): TRPCError => {
  const conditions: string[] = []

  if (references.credentialCount > 0) {
    conditions.push(
      references.credentialCount === 1
        ? 'it holds 1 agent credential; move it to another group or archive it first'
        : `it holds ${String(references.credentialCount)} agent credentials; move them to another group or archive them first`,
    )
  }

  if (references.attachedProfiles.length > 0) {
    conditions.push(
      `it is attached to the execution ${references.attachedProfiles.length === 1 ? 'profile' : 'profiles'} ${references.attachedProfiles
        .map((profile) => profile.name)
        .join(', ')}; detach it there first`,
    )
  }

  return new TRPCError({
    code: 'CONFLICT',
    message: [
      `The credential group ${group.name} cannot be deleted:`,
      ...conditions.map((condition) => `- ${condition}`),
      'Disable it instead to withhold every member from future selection without interrupting any run currently holding one.',
    ].join('\n'),
  })
}

/** What `setEnabled` and `delete` answer with. */
export interface CredentialGroupChanged {
  readonly group: CredentialGroup
  /**
   * Runs holding a credential from this group at the moment of the change.
   *
   * Reported because disabling a group withholds its members from *future* selection and evicts
   * nothing (FR-006 applied group-wide). An administrator taking a pool out of circulation needs to
   * know whether that leaves three runs finishing on it or none — and the number goes onto the
   * trail, where it is the only record of what was in flight when the decision was made.
   */
  readonly liveHolderCount: number
}

/** What `moveCredential` answers with. */
export interface CredentialMoved {
  readonly credential: AgentCredential
  readonly fromCredentialGroupId: string
  readonly toCredentialGroupId: string
}

/** What every attachment mutation answers with — the profile's whole order, after the change. */
export interface ProfileAttachments {
  readonly executionProfileId: string
  readonly attachments: readonly ProfileCredentialGroupAttachment[]
}

/**
 * Resolve a group that exists and has not been archived.
 *
 * Archived is refused rather than reported as missing: an administrator who archived a group last
 * month and is now trying to attach it needs to be told it was archived, not told it never existed.
 */
const requireLiveGroup = async (
  writer: Parameters<typeof findCredentialGroup>[0],
  credentialGroupId: string,
): Promise<CredentialGroup> => {
  const group = await findCredentialGroup(writer, credentialGroupId)

  if (group === undefined) {
    throw credentialTargetNotFoundError()
  }

  if (group.archivedAt !== null) {
    throw credentialGroupStateError(
      `The credential group ${group.name} has been deleted and cannot be used.`,
    )
  }

  return group
}

export const credentialGroupsRouter = createTRPCRouter({
  /** Every group, with how many credentials it holds and how many profiles draw on it (FR-060). */
  list: adminProcedure.input(listCredentialGroupsInput).query(
    async ({ ctx, input }): Promise<Page<CredentialGroupListing>> =>
      listCredentialGroups(ctx.db, {
        enabledOnly: input.enabledOnly,
        includeArchived: input.includeArchived,
        limit: input.limit,
        cursor: input.cursor,
      }),
  ),

  /** What blocks deleting this group, and whether anything does (FR-066). */
  references: adminProcedure
    .input(credentialGroupIdInput)
    .query(async ({ ctx, input }): Promise<CredentialGroupReferences> => {
      if ((await findCredentialGroup(ctx.db, input.credentialGroupId)) === undefined) {
        throw credentialTargetNotFoundError()
      }
      return readCredentialGroupReferences(ctx.db, input.credentialGroupId)
    }),

  /**
   * Create a group (FR-060).
   *
   * Enabled on creation, unlike a profile or a bundle. A new group is empty and can therefore hand
   * nothing to anyone; the gate that matters is on each credential's own `state`, which starts at
   * `awaiting_login` and is unselectable until a login is proven (FR-008). Starting disabled would
   * add a step whose only distinctive property is being forgotten.
   */
  create: adminProcedure.input(createCredentialGroupInput).mutation(
    async ({ ctx, input }): Promise<CredentialGroup> =>
      ctx.db.transaction(async (tx) => {
        if ((await findCredentialGroupByName(tx, input.name)) !== undefined) {
          throw duplicateCredentialGroupNameError(input.name)
        }

        const group = await insertCredentialGroup(tx, {
          name: input.name,
          description: input.description,
          createdByUserId: ctx.user.id,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'credential_group',
          entityId: group.id,
          action: 'registered',
          detail: { name: group.name, description: group.description },
        })

        return group
      }),
  ),

  /**
   * Rename a group, and edit its description (FR-067).
   *
   * The previous name goes onto the trail. A rename is the one edit that makes every earlier entry
   * in the trail harder to read — they name a group that no longer answers to that name — and
   * recording what it was called is what keeps the history joinable.
   */
  rename: adminProcedure.input(renameCredentialGroupInput).mutation(
    async ({ ctx, input }): Promise<CredentialGroup> =>
      ctx.db.transaction(async (tx) => {
        const existing = await requireLiveGroup(tx, input.credentialGroupId)

        if (input.name !== existing.name) {
          const clash = await findCredentialGroupByName(tx, input.name)
          if (clash !== undefined && clash.id !== existing.id) {
            throw duplicateCredentialGroupNameError(input.name)
          }
        }

        const group = await updateCredentialGroup(tx, existing.id, {
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description ?? null }),
        })

        if (group === undefined) {
          // Unreachable: the row was read inside this transaction.
          throw credentialTargetNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'credential_group',
          entityId: group.id,
          action: 'updated',
          detail: { previousName: existing.name, name: group.name },
        })

        return group
      }),
  ),

  /**
   * Disable or re-enable a group (FR-066, FR-006 applied group-wide).
   *
   * Disabling withholds **every** member from future selection and interrupts nothing: a run
   * holding one of this group's credentials keeps it until it terminates, and the count of those
   * runs is returned and recorded so the consequence is visible rather than inferred.
   *
   * **Disabling is never gated, even when it makes an enabled profile unlaunchable.** That is a
   * deliberate asymmetry with `detach` below, which *is* refused in the same situation. Disabling is
   * the platform's only way to take a broken pool out of service — FR-066 offers it as the
   * alternative to a deletion it forbids — and an administrator whose credentials have all started
   * failing must not be told they may not withdraw them because a profile still points at them.
   * Detaching has an obvious alternative (attach the replacement first); withdrawing a group does
   * not. The FR-065 gate still refuses to *enable* the affected profiles afterwards, so the
   * unlaunchable state is surfaced at the next configuration change rather than hidden.
   *
   * A no-op writes no audit entry: nothing changed, and a trail padded with non-events is harder to
   * read.
   */
  setEnabled: adminProcedure.input(setCredentialGroupEnabledInput).mutation(
    async ({ ctx, input }): Promise<CredentialGroupChanged> =>
      ctx.db.transaction(async (tx) => {
        const existing = await requireLiveGroup(tx, input.credentialGroupId)
        const liveHolderCount = await countLiveLeasesInGroup(tx, existing.id)

        if (existing.enabled === input.enabled) {
          return { group: existing, liveHolderCount }
        }

        const group = await updateCredentialGroup(tx, existing.id, { enabled: input.enabled })
        if (group === undefined) {
          throw credentialTargetNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'credential_group',
          entityId: group.id,
          action: input.enabled ? 'enabled' : 'disabled',
          detail: { name: group.name, liveHolderCount },
        })

        return { group, liveHolderCount }
      }),
  ),

  /**
   * Delete a group — **refused whenever FR-066's conditions hold**, which is most of the time.
   *
   * What succeeds is a soft delete: `archived_at` is written and the row stays, because a group id
   * appears in the audit trail and in nothing that could be repaired by its disappearance. What is
   * refused is any deletion of a group that still holds a credential or is still attached to a
   * profile, and the refusal names which — see {@link credentialGroupNotDeletableError}.
   *
   * The reference sweep runs inside the transaction that would archive the row, so a group cannot be
   * deleted on the strength of a sweep taken before a concurrent registration filed a credential
   * under it.
   */
  delete: adminProcedure.input(credentialGroupIdInput).mutation(
    async ({ ctx, input }): Promise<CredentialGroup> =>
      ctx.db.transaction(async (tx) => {
        const existing = await requireLiveGroup(tx, input.credentialGroupId)
        const references = await readCredentialGroupReferences(tx, existing.id)

        if (!references.deletable) {
          throw credentialGroupNotDeletableError(existing, references)
        }

        const group = await updateCredentialGroup(tx, existing.id, {
          archivedAt: new Date(),
          enabled: false,
        })

        if (group === undefined) {
          throw credentialTargetNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'credential_group',
          entityId: group.id,
          action: 'disabled',
          detail: { name: group.name, archived: true },
        })

        return group
      }),
  ),

  /**
   * Move a credential into this group (FR-061, FR-067).
   *
   * A credential belongs to exactly one group at all times, so this is a move and never an
   * additional membership — which is why the destination is the only group named and the source is
   * read rather than given.
   *
   * A credential a workflow is currently holding may be moved. The move governs **future**
   * selection only, exactly as disabling does (FR-006): the run in flight keeps the identity it was
   * given, because FR-023 forbids substituting another mid-run and there would be nothing to gain by
   * interrupting it. Both group ids go onto the trail, which is what makes "why did this profile
   * stop finding capacity" answerable afterwards.
   */
  moveCredential: adminProcedure.input(moveCredentialToGroupInput).mutation(
    async ({ ctx, input }): Promise<CredentialMoved> =>
      ctx.db.transaction(async (tx) => {
        // An archived credential is reported as missing rather than as archived, unlike an
        // archived *group*: FR-005 archives a credential precisely because a run used it, so its
        // continued existence is a historical fact rather than an administrable one.
        const credential = await findAgentCredential(tx, input.agentCredentialId)
        if (credential?.archivedAt !== null) {
          throw credentialTargetNotFoundError()
        }

        const destination = await requireLiveGroup(tx, input.credentialGroupId)

        if (credential.credentialGroupId === destination.id) {
          return {
            credential,
            fromCredentialGroupId: destination.id,
            toCredentialGroupId: destination.id,
          }
        }

        const moved = await updateAgentCredential(tx, credential.id, {
          credentialGroupId: destination.id,
        })

        if (moved === undefined) {
          throw credentialTargetNotFoundError()
        }

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'agent_credential',
          entityId: moved.id,
          action: 'updated',
          detail: {
            name: moved.name,
            fromCredentialGroupId: credential.credentialGroupId,
            toCredentialGroupId: destination.id,
          },
        })

        return {
          credential: moved,
          fromCredentialGroupId: credential.credentialGroupId,
          toCredentialGroupId: destination.id,
        }
      }),
  ),

  /** A profile's attached groups, in preference order (FR-062, FR-064). */
  forProfile: adminProcedure
    .input(profileCredentialGroupsInput)
    .query(async ({ ctx, input }): Promise<ProfileAttachments> => {
      if ((await findProfile(ctx.db, input.executionProfileId)) === undefined) {
        throw credentialTargetNotFoundError()
      }

      return {
        executionProfileId: input.executionProfileId,
        attachments: await readProfileCredentialGroups(ctx.db, input.executionProfileId),
      }
    }),

  /**
   * Attach a group to a profile, at the end of its preference order (FR-062).
   *
   * Appended rather than inserted at a chosen index: an administrator adding a fallback pool almost
   * always wants it tried last, and one who wants it first reorders — an explicit act with its own
   * trail entry, rather than a position argument whose meaning depends on what was already there.
   *
   * Attaching a group that is already attached writes nothing and records nothing. A repeated
   * request is not an error — an administrator double-clicking has done nothing wrong — and the
   * order is unchanged either way.
   */
  attach: adminProcedure.input(attachCredentialGroupInput).mutation(
    async ({ ctx, input }): Promise<ProfileAttachments> =>
      ctx.db.transaction(async (tx) => {
        // An archived profile cannot be launched and cannot be edited, so it gets no attachments.
        const profile = await findProfile(tx, input.executionProfileId)
        if (profile?.archivedAt !== null) {
          throw credentialTargetNotFoundError()
        }

        const group = await requireLiveGroup(tx, input.credentialGroupId)
        const attached = await attachCredentialGroup(tx, {
          executionProfileId: profile.id,
          credentialGroupId: group.id,
        })

        if (attached !== undefined) {
          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'credential_group',
            entityId: group.id,
            action: 'granted',
            detail: {
              name: group.name,
              executionProfileId: profile.id,
              executionProfileName: profile.name,
              position: attached.position,
            },
          })
        }

        return {
          executionProfileId: profile.id,
          attachments: await readProfileCredentialGroups(tx, profile.id),
        }
      }),
  ),

  /**
   * Detach a group from a profile, closing the gap it leaves (FR-062).
   *
   * **Refused when it would leave an enabled profile with nothing usable to draw on** (FR-065). The
   * check is the same `credentialGroupAttachmentCheck` the enable gate runs, applied to the order
   * this call *would* produce — one rule, evaluated in two places, rather than two rules that agree
   * until somebody edits one of them. Without it, FR-065 would hold only for profiles nobody had
   * edited since enabling them: a profile could be made launchable, then stripped of its last
   * identity, and would fail at admission — which is precisely the outcome the requirement exists to
   * prevent.
   *
   * A **disabled** profile may be stripped to nothing. It cannot launch anything in that state, and
   * the enable gate stands between it and being able to; refusing here as well would mean an
   * administrator reorganising a retired profile had to attach a group they did not want in order to
   * remove the one they did.
   */
  detach: adminProcedure.input(detachCredentialGroupInput).mutation(
    async ({ ctx, input }): Promise<ProfileAttachments> =>
      ctx.db.transaction(async (tx) => {
        const profile = await findProfile(tx, input.executionProfileId)
        if (profile === undefined) {
          throw credentialTargetNotFoundError()
        }

        const current = await readProfileCredentialGroups(tx, input.executionProfileId)
        const going = current.find(
          (attachment) => attachment.credentialGroupId === input.credentialGroupId,
        )

        if (going === undefined) {
          throw credentialTargetNotFoundError()
        }

        if (profile.enabled) {
          const remaining = credentialGroupAttachmentCheck(
            current.filter(
              (attachment) => attachment.credentialGroupId !== going.credentialGroupId,
            ),
          )

          if (!remaining.passed) {
            throw credentialGroupStateError(
              [
                `Detaching ${going.name} would leave the enabled execution profile ${profile.name} unlaunchable:`,
                ...remaining.failures.map((failure) => `- ${failure.detail}`),
                'Attach another credential group first, or disable the profile.',
              ].join('\n'),
            )
          }
        }

        await detachCredentialGroup(tx, {
          executionProfileId: profile.id,
          credentialGroupId: going.credentialGroupId,
        })

        await recordConfigurationChange(tx, {
          actorUserId: ctx.user.id,
          entityType: 'credential_group',
          entityId: going.credentialGroupId,
          action: 'revoked',
          detail: {
            name: going.name,
            executionProfileId: profile.id,
            executionProfileName: profile.name,
            previousPosition: going.position,
          },
        })

        return {
          executionProfileId: profile.id,
          attachments: await readProfileCredentialGroups(tx, profile.id),
        }
      }),
  ),

  /**
   * Put a profile's attachments into a new preference order (FR-062, FR-064).
   *
   * The whole order is sent, and it must be **exactly** the set currently attached — no additions,
   * no omissions, no repeats. That is not pedantry about input shape: the panel builds its list from
   * an earlier read, and a list that disagrees with the database means somebody else attached or
   * detached a group in between. Applying the difference silently would attach or detach on the
   * strength of a stale view; refusing turns it into a reload.
   *
   * The renumbering itself keeps `profile_credential_groups_position_key` satisfied at every instant
   * rather than only at commit — see `renumberAttachments` in `credential-store.ts`, which is where
   * the sequencing argument lives.
   */
  reorder: adminProcedure.input(reorderCredentialGroupsInput).mutation(
    async ({ ctx, input }): Promise<ProfileAttachments> =>
      ctx.db.transaction(async (tx) => {
        const profile = await findProfile(tx, input.executionProfileId)
        if (profile === undefined) {
          throw credentialTargetNotFoundError()
        }

        const current = await readProfileCredentialGroups(tx, input.executionProfileId)
        const requested = input.credentialGroupIds
        const attachedIds = new Set(current.map((attachment) => attachment.credentialGroupId))
        const requestedIds = new Set(requested)

        if (
          requested.length !== requestedIds.size ||
          requestedIds.size !== attachedIds.size ||
          requested.some((credentialGroupId) => !attachedIds.has(credentialGroupId))
        ) {
          throw credentialGroupStateError(
            `The order given does not match the ${String(current.length)} credential ${
              current.length === 1 ? 'group' : 'groups'
            } currently attached to ${profile.name}. Reload the profile and try again — somebody may have attached or detached a group in the meantime.`,
          )
        }

        const previous = current.map((attachment) => attachment.credentialGroupId)
        const attachments = await reorderCredentialGroups(tx, profile.id, requested)

        // A reorder that changed nothing is a non-event, and the trail is more readable without it.
        if (previous.join() !== requested.join()) {
          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'credential_group',
            entityId: requested[0] ?? profile.id,
            action: 'updated',
            detail: {
              executionProfileId: profile.id,
              executionProfileName: profile.name,
              previousOrder: previous,
              order: [...requested],
            },
          })
        }

        return { executionProfileId: profile.id, attachments }
      }),
  ),
})

export type CredentialGroupsRouter = typeof credentialGroupsRouter
