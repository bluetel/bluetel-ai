import { z } from 'zod'

import { cursorPagination, nonEmptyText, uuidInput } from './common'

/**
 * Inputs for `admin.credentialGroups` and `admin.credentials` — the capacity pools agent
 * credentials belong to, the ordered attachments that scope them to execution profiles
 * (FR-060..FR-067), and the seats themselves (FR-004..FR-009, FR-061).
 *
 * Nothing here accepts credential material, and nothing here ever will. Material reaches the
 * platform only by being written to the secret store server-side (FR-011, FR-070); a panel input
 * that carried a token would put it in a request body, in a browser's memory and in whatever proxy
 * log sits between the two. The identifiers below are all these procedures need.
 *
 * The login flow is where that rule could plausibly have been broken, and it is not: `startLogin`
 * and `loginStatus` both take {@link agentCredentialIdInput} — a single id, the same input `get`
 * takes. There is no schema in this file for a login's *result*, because the result never crosses
 * this surface at all: the agent writes it on the login instance, the control plane reads it there
 * and puts it in the secret store (FR-069, FR-070).
 */

/** One group, by id. */
export const credentialGroupIdInput = z.object({ credentialGroupId: uuidInput })

export const listCredentialGroupsInput = cursorPagination.extend({
  enabledOnly: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
})

export const createCredentialGroupInput = z.object({
  name: nonEmptyText,
  description: z.string().optional(),
})

/**
 * Rename a group, and edit its description.
 *
 * `description` is `nullish` rather than `optional` so that clearing it and leaving it alone are
 * different requests: `undefined` means "not mentioned", `null` means "remove what is there". A
 * single `optional` would make the second unexpressible.
 */
export const renameCredentialGroupInput = z.object({
  credentialGroupId: uuidInput,
  name: nonEmptyText,
  description: z.string().nullish(),
})

/**
 * Disable or re-enable a group (FR-066).
 *
 * Disabling withholds **every** member from future selection without evicting a run currently
 * holding one — FR-006 applied group-wide — and it is what FR-066 offers in place of deletion for a
 * group that is in use.
 */
export const setCredentialGroupEnabledInput = z.object({
  credentialGroupId: uuidInput,
  enabled: z.boolean(),
})

/** Move a credential from whichever group it is in into this one (FR-061). */
export const moveCredentialToGroupInput = z.object({
  agentCredentialId: uuidInput,
  credentialGroupId: uuidInput,
})

/** Attach a group to a profile, at the end of its preference order (FR-062). */
export const attachCredentialGroupInput = z.object({
  executionProfileId: uuidInput,
  credentialGroupId: uuidInput,
})

/** Detach a group from a profile (FR-062, FR-065). */
export const detachCredentialGroupInput = attachCredentialGroupInput

/**
 * Put a profile's attachments into a new preference order (FR-062).
 *
 * The whole order is sent rather than a move-this-one-here delta. A delta is evaluated against the
 * order the panel *last saw*, which is not necessarily the order in the database by the time it
 * arrives; a full list is evaluated against the order that is actually there, and the resolver can
 * refuse when the two disagree instead of silently applying a shuffle the administrator did not
 * intend.
 */
export const reorderCredentialGroupsInput = z.object({
  executionProfileId: uuidInput,
  credentialGroupIds: z.array(uuidInput).min(1),
})

/** Read a profile's attachments, in preference order. */
export const profileCredentialGroupsInput = z.object({ executionProfileId: uuidInput })

/** One agent credential, by id. */
export const agentCredentialIdInput = z.object({ agentCredentialId: uuidInput })

/**
 * The pool listing (FR-009, FR-053).
 *
 * `includeArchived` defaults to `false` and exists at all because FR-005 archives rather than
 * deletes: a seat a finished run authenticated as is still the answer to "what was this run working
 * as", so the panel must be able to ask for it — while not showing it among the capacity by
 * default, because an archived credential is not capacity.
 *
 * `credentialGroupId` narrows to one pool. Optional rather than required so the default view is the
 * whole platform's capacity, which is the question an administrator investigating exhaustion is
 * actually asking.
 */
export const listAgentCredentialsInput = cursorPagination.extend({
  credentialGroupId: uuidInput.optional(),
  includeArchived: z.boolean().default(false),
})

/**
 * Register a seat (FR-061).
 *
 * A name and a group, and nothing else — **no secret, no material, no state**. The credential is
 * created in `awaiting_login` with `secret_id` null by the resolver, not by the caller: a request
 * that could name its own starting state could name `available`, and a credential that reached
 * `available` without a proven login is precisely what FR-008 exists to prevent.
 *
 * The group is required rather than defaulted because FR-061 assigns membership **at registration**
 * and there is no such thing as an ungrouped credential — a default would create one and leave
 * somebody to notice later that a whole pool's worth of seats had accumulated in it.
 */
export const registerAgentCredentialInput = z.object({
  name: nonEmptyText,
  credentialGroupId: uuidInput,
})

/**
 * Disable or re-enable a seat (FR-006).
 *
 * Disabling withholds the credential from **future** selection and interrupts nothing: a run
 * holding it keeps it until it terminates. That is the whole of FR-006, and it is why this is a
 * flag rather than a state transition — see `credential-store.ts` → `updateAgentCredential` for why
 * `state` is not an administrator's column.
 */
export const setAgentCredentialEnabledInput = z.object({
  agentCredentialId: uuidInput,
  enabled: z.boolean(),
})

/**
 * The pool view (FR-053, FR-054, FR-055, FR-074).
 *
 * One optional flag, and no pagination — which is the interesting part. Every other listing in this
 * file is keyset paginated; this one is not, because the figures the view exists for are **totals
 * per group**, and a second page that changed the answer to "is this group under-sized" would be
 * worse than a long page. The pool is bounded by how many agent identities an organisation has
 * bought, so the set is small by construction rather than by hope.
 *
 * `includeArchived` defaults to `false` for the reason it does on {@link listAgentCredentialsInput},
 * only more sharply: an archived seat is a historical record and not capacity, and counting one as
 * capacity is precisely how this screen could report a pool as larger than it is.
 */
export const credentialPoolInput = z.object({ includeArchived: z.boolean().default(false) })

/**
 * The `workflow_events.detail` discriminator that marks a `queued` entry as a wait for an **agent
 * credential** rather than for the concurrency ceiling (003/FR-024, FR-029, SC-006).
 *
 * `queued` already carries a meaning: a run was accepted and is waiting its turn under the FR-040
 * ceiling. Entering `awaiting_credential` is the same shape of event about a different scarcity —
 * the run is waiting, holds nothing, and will start when something frees — so it goes on the
 * timeline as a `queued` entry with this field to tell the two apart. The precedent is
 * `SNAPSHOT_PARK_WAITING_ON` in `./machine.ts`, which does exactly this for the two situations that
 * share the `parked` event. The alternative was a new member of the `workflow_event` enum: a
 * migration that rewrites nothing but adds a second vocabulary for a distinction the detail already
 * carries.
 *
 * Without the discriminator a reader would have to guess from the detail's shape, and would
 * eventually guess wrong — which here would mean telling an engineer that a run is waiting for a
 * credential when it is waiting for a machine.
 */
export const CREDENTIAL_WAIT_WAITING_ON = 'agent_credential'

/**
 * What entering `awaiting_credential` records, as it is read back off the timeline (003/FR-029).
 *
 * A parser rather than a cast: `workflow_events.detail` is `jsonb`, so what comes out is `unknown`
 * and the reader has no compile-time guarantee that the row it found was written by the version of
 * the control plane that is running now.
 *
 * **`kind` is a string here and not an enum, deliberately.** The vocabulary of wait reasons belongs
 * to the allocator that computes it —
 * `apps/sisyphus-control-plane/src/credentials/allocate/wait-reason.ts`, where the four FR-029 cases
 * are decided — and a second copy in this package would be a second thing to keep in step across a
 * deploy boundary that is genuinely allowed to skew: the panel may be reading rows written by a
 * control plane one release behind it. The field a reader *branches* on is `configurationFault` —
 * the difference between a queue that will drain and a mistake somebody must fix. `kind` is for
 * grouping and for a machine-readable trail; the sentences are what a person reads.
 */
export const credentialWaitDetail = z.object({
  waitingOn: z.literal(CREDENTIAL_WAIT_WAITING_ON),
  kind: nonEmptyText,
  /** True when no release and no delay resolves this: the remedy is a configuration change. */
  configurationFault: z.boolean(),
  /** The attached credential groups that were searched, in preference order (FR-029). */
  groups: z.array(z.object({ name: nonEmptyText, position: z.number().int() })),
  summary: nonEmptyText,
  remedy: nonEmptyText,
})

export type CredentialWaitDetail = z.infer<typeof credentialWaitDetail>

export type CredentialGroupIdInput = z.infer<typeof credentialGroupIdInput>
export type ListCredentialGroupsInput = z.infer<typeof listCredentialGroupsInput>
export type CreateCredentialGroupInput = z.infer<typeof createCredentialGroupInput>
export type RenameCredentialGroupInput = z.infer<typeof renameCredentialGroupInput>
export type SetCredentialGroupEnabledInput = z.infer<typeof setCredentialGroupEnabledInput>
export type MoveCredentialToGroupInput = z.infer<typeof moveCredentialToGroupInput>
export type AttachCredentialGroupInput = z.infer<typeof attachCredentialGroupInput>
export type DetachCredentialGroupInput = z.infer<typeof detachCredentialGroupInput>
export type ReorderCredentialGroupsInput = z.infer<typeof reorderCredentialGroupsInput>
export type ProfileCredentialGroupsInput = z.infer<typeof profileCredentialGroupsInput>
export type AgentCredentialIdInput = z.infer<typeof agentCredentialIdInput>
export type ListAgentCredentialsInput = z.infer<typeof listAgentCredentialsInput>
export type RegisterAgentCredentialInput = z.infer<typeof registerAgentCredentialInput>
export type SetAgentCredentialEnabledInput = z.infer<typeof setAgentCredentialEnabledInput>
export type CredentialPoolInput = z.infer<typeof credentialPoolInput>
