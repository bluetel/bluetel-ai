import { TRPCError } from '@trpc/server'

import type { AgentCredential } from '../../db'
import {
  agentCredentialIdInput,
  listAgentCredentialsInput,
  registerAgentCredentialInput,
  setAgentCredentialEnabledInput,
} from '../../schemas'
import { adminProcedure, createTRPCRouter } from '../procedures'

import { recordConfigurationChange } from './audit-log'
import { credentialTargetNotFoundError } from './credential-groups'
import type {
  AgentCredentialLeaseReleases,
  ForcedLeaseRelease,
  ForcedReleaseWorkflowResolution,
} from './credential-leases'
import {
  forcedReleaseOutcomeReason,
  LEASE_RELEASE_NOT_CONFIGURED_REASON,
  resolveWorkflowForForcedRelease,
} from './credential-leases'
import type {
  AgentCredentialLoginEnvironments,
  LoginEnvironment,
  LoginRelay,
} from './credential-login'
import { createRefusingLoginEnvironments } from './credential-login'
import type { AgentCredentialListing } from './credential-store'
import {
  countLeasesForCredential,
  countLiveLeasesForCredential,
  findAgentCredential,
  findAgentCredentialByName,
  findAgentCredentialListing,
  findCredentialGroup,
  findLiveLeaseForCredential,
  insertAgentCredential,
  listAgentCredentials,
  LOGIN_ENTRY_STATES,
  recordAgentCredentialLoginFailure,
  updateAgentCredential,
} from './credential-store'
import type { Page } from './user-queries'

/**
 * `admin.credentials` — the seats themselves: registering one, driving its login, withdrawing it,
 * and refusing to delete one that history depends on (FR-004..FR-010, FR-061, FR-069..FR-072).
 *
 * Its sibling `admin.credentialGroups` administers the pools; this administers what is in them. The
 * two are separate mounts because a group outlives every credential filed under it and is
 * administered by whoever owns capacity, while a seat is an identity with a lifecycle of its own —
 * and because the audit trail records against both, so conflating them would make "what has
 * happened to this seat" and "what has happened to this pool" one unreadable history.
 *
 * ## Material never crosses this surface, and there is no procedure here that could carry it
 *
 * This is the property the whole feature reduces to on the administrative side, so it is worth
 * stating as a fact about the shapes rather than as an intention.
 *
 * `startLogin` and `loginStatus` both take **`{ agentCredentialId }` and nothing else** — the same
 * input as `get` and `delete`. `startLogin` answers with an instance id, two timestamps and the
 * three fields AWS's session client needs to open a terminal; `loginStatus` answers with the same
 * minus the terminal. Neither has a field a token could be put in.
 *
 * The material itself is produced by the agent **on the login instance**, read from there by the
 * control plane, and written to Secrets Manager server-side (`credentials/login/capture.ts`). The
 * panel is not on that path at any point — it never sees the value, and it never sees the request
 * that carries it, because that request is made inside the platform's own network.
 *
 * The previous phase's `adoptSecret` — which recorded the name of a secret an operator had written
 * by hand — **is gone**, and its deletion is part of this change rather than a follow-up. A
 * procedure that put a credential into service by naming an identifier would be a second, far less
 * tested way to reach `available`: it accepted no material, but it also proved no login, and a seat
 * could reach the pool without one ever having happened.
 *
 * ## Why the login flow is two procedures and no third
 *
 * There is **no `completeLogin`**. Nothing in the panel tells the platform the login worked: the
 * control plane watches the instance, captures the material when it appears, and destroys the
 * environment. The panel polls `loginStatus` and sees the seat turn `available`.
 *
 * That is not a convenience. A completion procedure would make the panel's report the trigger for
 * putting a seat into service, and the one case that matters most — the administrator who closes
 * the tab (FR-071) — is precisely the case where no report is ever sent. Building the happy path on
 * an event that the failure path cannot produce is how the failure path ends up untested. Here both
 * paths are driven by the same two things, the instance and the clock, and abandonment is not a
 * special case so much as the absence of a capture before the deadline.
 *
 * ## Why this router is built rather than declared
 *
 * `createCredentialsRouter` takes the login environments port as an argument, and
 * `credentialsRouter` is the one built with the **refusing** provisioner, exactly as
 * `integrationsRouter` is built with the refusing connector registry. A deployment supplies the real
 * one through `SisyphusDependencies.agentCredentialLogin`, which wins over the constructor argument
 * per request; the argument stays so the contract test can inject a fake without assembling a
 * context. See `credential-login.ts` for why the port exists at all — chiefly that this package
 * cannot import the control plane's AWS adapters.
 *
 * A deployment that wires none can register credentials and log none of them in, which is the
 * honest failure: the platform genuinely cannot provision an environment to log in inside.
 *
 * ## Everything here is admin-only, and everything here is audited
 *
 * FR-004: registering, logging in, disabling and deleting a credential all require the
 * administrator role and are recorded with the acting administrator, inside the same transaction as
 * the change, so a trail entry cannot survive a change that rolled back (SC-013). The reads are
 * admin-only too — a credential's state tells an engineer nothing they can act on (data-model.md →
 * Access scoping).
 */

/**
 * Refusal for a credential or group that exists but cannot be acted on in the state it is in.
 *
 * `CONFLICT` because the request is well-formed and the caller is entitled to make it — what is
 * wrong is the state of what they are pointing at. Safe to name that state: every caller here is an
 * administrator, who may already see every credential on the platform (FR-053). The sibling of
 * `credentialGroupStateError`, kept separate so a refusal about a seat does not have to be worded
 * as though it were about a pool.
 */
export const agentCredentialStateError = (reason: string): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message: reason })

/** Refusal for a credential name already taken. The name is the caller's own input. */
export const duplicateAgentCredentialNameError = (name: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `An agent credential named ${name} already exists. Names are unique across the platform so that a seat can be identified in an audit trail without a group to qualify it.`,
  })

/**
 * FR-005's refusal, naming what it is protecting.
 *
 * A credential any workflow has ever held is never deleted, because `credential_leases` and
 * `workflows.agent_credential_id` both point at it and both are how a finished run answers "what
 * identity did this work as". Deleting the row would either fail on the foreign key or succeed in
 * making that question unanswerable, and the second is worse than the first.
 *
 * The lease count is stated rather than a bare "it has been used", for the same reason FR-066's
 * refusal enumerates its conditions: an administrator who believes a seat was never issued needs to
 * see the number that says otherwise. Disabling is always named as the way forward, because FR-005's
 * whole shape is "not deletable, disableable instead" — a refusal that stopped at "no" would leave
 * them with a credential they can neither remove nor withdraw.
 */
export const agentCredentialNotDeletableError = (
  credential: Pick<AgentCredential, 'name'>,
  leaseCount: number,
): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: [
      `The agent credential ${credential.name} cannot be deleted: it has been leased ${
        leaseCount === 1 ? '1 time' : `${String(leaseCount)} times`
      }, and the runs that held it reference it as the identity they worked as.`,
      'Disable it instead to withhold it from future selection without interrupting any run currently holding it.',
    ].join('\n'),
  })

/**
 * The refusal when a login environment could not be provisioned.
 *
 * `CONFLICT` rather than `INTERNAL_SERVER_ERROR`, and the provisioner's own reason is quoted: "this
 * deployment has no login environment configured", "EC2 has no capacity in this region" and "the
 * seat already has a login in progress" are fixed in three entirely different places by three
 * different people, and a bare 500 would send all of them to the same fruitless log search.
 *
 * The sentence about the credential being left alone is not padding. FR-008's guarantee is that a
 * seat becomes selectable only once a login has been *proved*, and an administrator who has just
 * seen a failure needs to know that nothing partial was recorded — otherwise the reasonable next
 * move is to go looking for something to clean up.
 */
export const loginNotStartableError = (credentialName: string, reason: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: [
      `The login environment for ${credentialName} could not be started: ${reason}.`,
      'The credential has been left exactly as it was, and unselectable. The reason is recorded against the seat as well, so it is still there after this message is gone.',
    ].join('\n'),
  })

/** What `setEnabled` and `delete` answer with. */
export interface AgentCredentialChanged {
  readonly credential: AgentCredential
  /**
   * Whether a run is holding this credential at the moment of the change — 1 or 0, by
   * `credential_leases_live_key`.
   *
   * Reported because FR-006 disables *future* selection and evicts nothing, and an administrator
   * withdrawing a seat needs to know whether that leaves a run finishing on it. The number goes onto
   * the trail as well, where it is the only record of what was in flight when the decision was made.
   */
  readonly liveHolderCount: number
}

/**
 * The refusal when there is nothing to force-release.
 *
 * `CONFLICT` and not `NOT_FOUND`: the seat exists and the administrator may act on it — it is
 * simply not held, which is the state they were trying to reach. The message says so plainly
 * because the panel offers the control from a pool view that may be a few seconds stale, and "the
 * run finished on its own" is by far the likeliest explanation.
 */
export const noLeaseToForceReleaseError = (credentialName: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `The agent credential ${credentialName} is not held by any run, so there is no lease to force-release. A run that was holding it a moment ago has released it itself, which is the same outcome without anything being seized.`,
  })

/**
 * The refusal when this deployment cannot release a lease at all.
 *
 * Thrown **before** anything is written, which is the whole reason it exists rather than a refusing
 * default doing the rejecting. A force-release resolves the run first and frees the seat second
 * (see `credential-leases.ts` for why that order and not the other), so a deployment that
 * discovered its missing seam halfway would have ended somebody's run and freed nothing.
 */
export const forceReleaseNotConfiguredError = (credentialName: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: [
      `The lease on ${credentialName} could not be force-released: ${LEASE_RELEASE_NOT_CONFIGURED_REASON}.`,
      'Nothing has been changed — neither the run holding the seat nor the seat itself.',
    ].join('\n'),
  })

/** What `forceRelease` answers with (FR-057). */
export interface ForceReleasedCredential {
  /** The seat as it stands after the release. `available` unless it was unwell while held. */
  readonly credential: AgentCredential
  /** What happened to the lease. */
  readonly release: ForcedLeaseRelease
  /** What happened to the run that was holding it — the "recorded state" FR-057 asks for. */
  readonly workflow: ForcedReleaseWorkflowResolution
}

/** What `startLogin` answers with — identifiers, instants and a terminal handle. Never material. */
export interface StartedCredentialLogin {
  /** The seat as it stands after the attempt began: unchanged, and still unselectable. */
  readonly credential: AgentCredential
  readonly environment: LoginEnvironment
  /**
   * The one relay handle issued for this attempt.
   *
   * Answered by the mutation and by nothing else. `loginStatus` is a query — a cacheable GET as far
   * as every layer between here and the browser is concerned — and a session handle that could be
   * re-fetched by polling would be one a proxy or a browser cache could hold on to.
   */
  readonly relay: LoginRelay
}

/** What `loginStatus` answers with. The same shape minus the terminal. */
export interface CredentialLoginStatus {
  readonly credential: AgentCredentialListing
  /** The live environment, or `undefined` when no login is in flight for this seat. */
  readonly environment: LoginEnvironment | undefined
  /**
   * Whether the live environment is past its deadline **as the panel's own clock sees it**.
   *
   * Reported rather than acted on. The reap is the reaper's — see `credential-login.ts` — and a
   * status query that destroyed things would make "what is happening" depend on somebody looking.
   * This flag exists so the panel can say "this attempt has run out and is being cleaned up"
   * instead of showing a session that will never open.
   */
  readonly expired: boolean
}

/** What `createCredentialsRouter` is built with. */
export interface CredentialsRouterOptions {
  /**
   * Where a login runs.
   *
   * Defaults to {@link createRefusingLoginEnvironments}, which refuses to start one. A per-request
   * provisioner on `ctx.dependencies.agentCredentialLogin` wins over this — which host provisions
   * compute is a property of the deployment, not of the router.
   */
  readonly loginEnvironments?: AgentCredentialLoginEnvironments
  /**
   * How a lease is taken back from a run (FR-057).
   *
   * There is **no refusing default**, unlike {@link CredentialsRouterOptions.loginEnvironments}.
   * Absence is checked and refused before the procedure writes anything; see
   * {@link forceReleaseNotConfiguredError} and the ordering note in `credential-leases.ts`.
   * `ctx.dependencies.agentCredentialLeases` wins over this, for the same reason the login
   * provisioner does.
   */
  readonly leaseReleases?: AgentCredentialLeaseReleases
}

/**
 * Resolve a credential that exists and has not been archived.
 *
 * An archived credential is reported as **missing** rather than as archived, unlike an archived
 * group. The asymmetry follows FR-005: a credential is archived precisely because a run used it, so
 * its continued existence is a historical fact rather than an administrable one, and offering it
 * back as something to act on would invite an administrator to try.
 */
const requireLiveCredential = async (
  writer: Parameters<typeof findAgentCredential>[0],
  agentCredentialId: string,
): Promise<AgentCredential> => {
  const credential = await findAgentCredential(writer, agentCredentialId)

  if (credential?.archivedAt !== null) {
    throw credentialTargetNotFoundError()
  }

  return credential
}

/** Whether a login may be started from this state. See {@link LOGIN_ENTRY_STATES}. */
const acceptsLogin = (state: AgentCredential['state']): boolean =>
  LOGIN_ENTRY_STATES.some((entry) => entry === state)

export const createCredentialsRouter = (options: CredentialsRouterOptions = {}) =>
  createTRPCRouter({
    /**
     * The pool, newest first, with each seat's state, its group and whether it is actually usable
     * (FR-009, FR-053).
     *
     * `selectable` is computed by the database from the same predicate a selector filters on — see
     * `selectableCredentialCondition` in `credential-store.ts`. It is the difference between a
     * screen that says what the pool *is* and one that says what the pool *looks like*.
     */
    list: adminProcedure.input(listAgentCredentialsInput).query(
      async ({ ctx, input }): Promise<Page<AgentCredentialListing>> =>
        listAgentCredentials(ctx.db, {
          credentialGroupId: input.credentialGroupId,
          includeArchived: input.includeArchived,
          limit: input.limit,
          cursor: input.cursor,
        }),
    ),

    /** One seat, as the pool view renders it. */
    get: adminProcedure
      .input(agentCredentialIdInput)
      .query(async ({ ctx, input }): Promise<AgentCredentialListing> => {
        const credential = await findAgentCredentialListing(ctx.db, input.agentCredentialId)

        if (credential === undefined) {
          throw credentialTargetNotFoundError()
        }

        return credential
      }),

    /**
     * Register a seat into a group (FR-061, FR-008, FR-004).
     *
     * It lands in `awaiting_login` with `secret_id` null, and both halves of that are set by the
     * store rather than by the caller — see `insertAgentCredential`. Until a login is proven the
     * credential is invisible to every selection path at once: the state keeps it out of the
     * predicate, and the null secret means there would be nothing to fetch even if something
     * reached past the state.
     *
     * The group must exist and must not have been deleted. A disabled group is accepted: disabling
     * withholds a pool from selection, which is a statement about capacity rather than about
     * whether an administrator may prepare a seat inside it — and refusing here would make the
     * obvious way to stage replacement capacity ("disable the pool, rebuild it, re-enable it")
     * impossible.
     */
    register: adminProcedure.input(registerAgentCredentialInput).mutation(
      async ({ ctx, input }): Promise<AgentCredential> =>
        ctx.db.transaction(async (tx) => {
          const group = await findCredentialGroup(tx, input.credentialGroupId)

          if (group === undefined) {
            throw credentialTargetNotFoundError()
          }

          if (group.archivedAt !== null) {
            throw agentCredentialStateError(
              `The credential group ${group.name} has been deleted and cannot be used.`,
            )
          }

          if ((await findAgentCredentialByName(tx, input.name)) !== undefined) {
            throw duplicateAgentCredentialNameError(input.name)
          }

          const credential = await insertAgentCredential(tx, {
            name: input.name,
            credentialGroupId: group.id,
            createdByUserId: ctx.user.id,
          })

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'agent_credential',
            entityId: credential.id,
            action: 'registered',
            detail: {
              name: credential.name,
              credentialGroupId: group.id,
              credentialGroupName: group.name,
              state: credential.state,
            },
          })

          return credential
        }),
    ),

    /**
     * Provision the hosted login environment for a seat and hand back a session into it
     * (FR-007, FR-009, FR-010, FR-069..FR-072).
     *
     * **The input is an id and nothing else, and that is FR-070.** There is no field on this
     * procedure for material, for a secret name, or for anything an administrator could have
     * obtained by logging in somewhere else — because the login happens inside platform
     * infrastructure and its result never leaves it. What comes back is an instance id, two
     * timestamps and the handle AWS's session client needs to attach a terminal.
     *
     * **This is also re-login** (FR-010, FR-072). {@link LOGIN_ENTRY_STATES} is
     * `awaiting_login` and `unhealthy`, so a broken seat returns to service through the identical
     * path a new one enters by — not a similar path, the same procedure, the same environment, the
     * same capture. That is the requirement's entire content: recovering a credential must not be
     * the lesser-tested half of the flow.
     *
     * **A `held` seat is refused, and that refusal is a safety property.** Replacing the material
     * of an identity a run is currently authenticated as would invalidate the copy that run is
     * using, mid-flight, with nothing to tell it why its next call failed.
     *
     * **A provisioning failure is recorded against the credential** (FR-009) before it is thrown.
     * A refusal an administrator has dismissed is a refusal nobody can find again, and the seat
     * they are looking at in the pool view is where they will look for the explanation.
     */
    startLogin: adminProcedure
      .input(agentCredentialIdInput)
      .mutation(async ({ ctx, input }): Promise<StartedCredentialLogin> => {
        const existing = await requireLiveCredential(ctx.db, input.agentCredentialId)

        if (!acceptsLogin(existing.state)) {
          throw agentCredentialStateError(
            `The agent credential ${existing.name} is ${existing.state}, which is not a state a login can be started from. A login is how a seat that has never worked, or one that has stopped working, is put into service — an available seat already has material, and replacing it would invalidate the copy the pool is about to hand out.`,
          )
        }

        const environments =
          ctx.dependencies.agentCredentialLogin ??
          options.loginEnvironments ??
          createRefusingLoginEnvironments()

        // Outside a transaction on purpose: provisioning an instance is an outbound call that
        // takes seconds, and holding a database transaction open across one would pin a connection
        // for its whole duration. Nothing here needs to be atomic with it — the credential is not
        // moved by starting a login, which is the point of the next paragraph.
        let started
        try {
          started = await environments.start({
            agentCredentialId: existing.id,
            credentialName: existing.name,
          })
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : 'the reason was not reported'
          await recordAgentCredentialLoginFailure(
            ctx.db,
            existing.id,
            `The login environment could not be started: ${reason}`,
          )
          throw loginNotStartableError(existing.name, reason)
        }

        // **The credential's state does not move.** A seat with a login in progress is exactly as
        // unselectable as it was a moment before — FR-008 admits `available` only on a *proved*
        // login — so there is no in-between state to invent, nothing to unwind when the attempt is
        // abandoned, and no way for a half-finished login to be handed to a run.
        await recordConfigurationChange(ctx.db, {
          actorUserId: ctx.user.id,
          entityType: 'agent_credential',
          entityId: existing.id,
          action: 'updated',
          detail: {
            name: existing.name,
            state: existing.state,
            loginStarted: true,
            // The environment and its deadline, so the trail can answer "what was provisioned, and
            // when should it have gone away" without an AWS console. Identifiers only.
            environmentId: started.environment.environmentId,
            expiresAt: started.environment.expiresAt.toISOString(),
          },
        })

        return { credential: existing, environment: started.environment, relay: started.relay }
      }),

    /**
     * What is happening to a seat's login, for the page the administrator is watching (FR-009).
     *
     * A **query**, and it changes nothing — including when it finds an environment past its
     * deadline. Destroying it here would make the reap depend on somebody having the page open,
     * which is the exact inversion of what FR-071 asks for; the wall-clock reaper does that job
     * whether or not anybody is looking, and this only reports what it will find.
     *
     * The credential comes back as the same listing `get` answers with, `selectable` verdict and
     * all, so the page shows what the pool shows rather than a second opinion about it. When the
     * capture has landed, the state reads `available` here — and that, rather than any report the
     * panel makes, is how a login is known to have worked.
     */
    loginStatus: adminProcedure
      .input(agentCredentialIdInput)
      .query(async ({ ctx, input }): Promise<CredentialLoginStatus> => {
        const credential = await findAgentCredentialListing(ctx.db, input.agentCredentialId)

        if (credential === undefined) {
          throw credentialTargetNotFoundError()
        }

        const environments =
          ctx.dependencies.agentCredentialLogin ??
          options.loginEnvironments ??
          createRefusingLoginEnvironments()

        const environment = await environments.find(credential.id)

        return {
          credential,
          environment,
          expired: environment !== undefined && environment.expiresAt.getTime() <= Date.now(),
        }
      }),

    /**
     * Disable or re-enable a seat (FR-006).
     *
     * **Disabling withholds it from future selection and touches no live holder.** A run that is
     * authenticated as this identity keeps it until it terminates — FR-023 forbids substituting
     * another credential mid-run, and there would be nothing to gain by interrupting it — so the
     * count of runs this is *not* interrupting is returned and recorded rather than left to be
     * inferred.
     *
     * The lever is `enabled` rather than the `disabled` **state**, deliberately, and it mirrors
     * what `credentialGroups.setEnabled` does one level up. `state` belongs to the leasing protocol:
     * writing `disabled` over `held` would erase the fact that a run holds the seat, and the
     * release that followed would have nothing coherent to return to. The selection predicate reads
     * `enabled` as well as `state`, so the flag is sufficient — a disabled credential is
     * unselectable whatever state it is in, including while it is being held.
     *
     * A no-op writes no audit entry: nothing changed, and a trail padded with non-events is harder
     * to read.
     */
    setEnabled: adminProcedure.input(setAgentCredentialEnabledInput).mutation(
      async ({ ctx, input }): Promise<AgentCredentialChanged> =>
        ctx.db.transaction(async (tx) => {
          const existing = await requireLiveCredential(tx, input.agentCredentialId)
          const liveHolderCount = await countLiveLeasesForCredential(tx, existing.id)

          if (existing.enabled === input.enabled) {
            return { credential: existing, liveHolderCount }
          }

          const credential = await updateAgentCredential(tx, existing.id, {
            enabled: input.enabled,
          })

          if (credential === undefined) {
            // Unreachable: the row was read inside this transaction.
            throw credentialTargetNotFoundError()
          }

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'agent_credential',
            entityId: credential.id,
            action: input.enabled ? 'enabled' : 'disabled',
            detail: { name: credential.name, state: credential.state, liveHolderCount },
          })

          return { credential, liveHolderCount }
        }),
    ),

    /**
     * Take a seat back from the run holding it (FR-057, FR-058, SC-012, SC-015).
     *
     * **This is the one control on this surface that ends somebody else's run**, and everything
     * about its shape follows from that.
     *
     * It is the recovery move for a seat whose login has broken while a run holds it. Disabling
     * withholds the seat from *future* selection and deliberately interrupts nothing (FR-006), so a
     * broken credential a long-running workflow is sitting on cannot be re-logged-in — `startLogin`
     * refuses a `held` seat, because replacing the material of an identity a run is authenticated
     * as would invalidate the copy that run is using. Force-release is what breaks that deadlock,
     * and SC-012's "under 5 minutes" is the sequence disable → force-release → re-login.
     *
     * **Three writes, in an order chosen for what a crash leaves behind.**
     *
     * 1. The run is resolved to a recorded state — `failed`, with a sentence naming the credential
     *    and the administrator, and a timeline entry attributed to them. FR-023 forbids moving a
     *    workflow to a different credential under any circumstance, so there is no seat for it to
     *    continue on and ending it is the only honest outcome.
     * 2. The lease is released as `forced` with `released_by_user_id` set, through the seam in
     *    `credential-leases.ts` — the control plane owns release, and this package cannot import an
     *    application.
     * 3. The `force_released` audit entry is written by that release, inside its transaction,
     *    attributed to the acting administrator (FR-058). It is deliberately **not** written here:
     *    an entry outside the transaction that frees the seat would survive a rollback and record a
     *    release that never happened.
     *
     * Resolving the run first is the recovery decision, not an implementation detail — see the
     * ordering note in `credential-leases.ts`. It is also why an unwired deployment is refused up
     * front rather than by a refusing default rejecting at step 2.
     *
     * **A run that finished on its own between the read and the write is not a failure.** Its own
     * account of how it ended stands (FR-064 allows exactly one outcome in force), and the release
     * answers `not_held`. The administrator gets the outcome they wanted with nothing seized.
     */
    forceRelease: adminProcedure
      .input(agentCredentialIdInput)
      .mutation(async ({ ctx, input }): Promise<ForceReleasedCredential> => {
        const existing = await requireLiveCredential(ctx.db, input.agentCredentialId)
        const lease = await findLiveLeaseForCredential(ctx.db, existing.id)

        if (lease === undefined) {
          throw noLeaseToForceReleaseError(existing.name)
        }

        const releases = ctx.dependencies.agentCredentialLeases ?? options.leaseReleases

        if (releases === undefined) {
          // Before the workflow is touched. See the module note in `credential-leases.ts`: the run
          // is resolved first, so discovering the missing seam afterwards would have failed a run
          // and freed no seat.
          throw forceReleaseNotConfiguredError(existing.name)
        }

        const workflow = await resolveWorkflowForForcedRelease({
          db: ctx.db,
          workflowId: lease.workflowId,
          actorUserId: ctx.user.id,
          outcomeReason: forcedReleaseOutcomeReason(existing.name, ctx.user.email),
        })

        const release = await releases.forceRelease({
          agentCredentialId: existing.id,
          workflowId: lease.workflowId,
          releasedByUserId: ctx.user.id,
        })

        // Re-read rather than inferred. Release does not repair — a seat that went `unhealthy`
        // while it was held comes back `unhealthy` — and an administrator who forced it free in
        // order to re-log it in needs the state the row actually holds, not `available` assumed.
        const credential = await findAgentCredential(ctx.db, existing.id)

        if (credential === undefined) {
          throw credentialTargetNotFoundError()
        }

        return { credential, release, workflow }
      }),

    /**
     * Delete a seat — **refused the moment any lease has ever referenced it** (FR-005).
     *
     * What succeeds is a soft delete: `archived_at` is written, `enabled` is cleared and the row
     * stays, because a credential id appears in the audit trail and in nothing that its
     * disappearance would repair. What is refused is deleting a credential a workflow has used, and
     * the refusal names how many times it was leased — see
     * {@link agentCredentialNotDeletableError}.
     *
     * The lease sweep runs inside the transaction that would archive the row, so a credential cannot
     * be deleted on the strength of a count taken before a concurrent acquisition wrote a lease
     * against it.
     */
    delete: adminProcedure.input(agentCredentialIdInput).mutation(
      async ({ ctx, input }): Promise<AgentCredential> =>
        ctx.db.transaction(async (tx) => {
          const existing = await requireLiveCredential(tx, input.agentCredentialId)
          const leaseCount = await countLeasesForCredential(tx, existing.id)

          if (leaseCount > 0) {
            throw agentCredentialNotDeletableError(existing, leaseCount)
          }

          const credential = await updateAgentCredential(tx, existing.id, {
            archivedAt: new Date(),
            enabled: false,
          })

          if (credential === undefined) {
            throw credentialTargetNotFoundError()
          }

          await recordConfigurationChange(tx, {
            actorUserId: ctx.user.id,
            entityType: 'agent_credential',
            entityId: credential.id,
            action: 'disabled',
            detail: { name: credential.name, archived: true },
          })

          return credential
        }),
    ),
  })

/**
 * The default mount — wired to the **refusing** login provisioner.
 *
 * A deployment that supplies `SisyphusDependencies.agentCredentialLogin` can log a seat in; one that
 * does not gets a refusal naming the missing configuration, rather than a login that appears to
 * begin and provisions nothing. Same choice, for the same reason, as `integrationsRouter` and the
 * connector registry.
 */
export const credentialsRouter = createCredentialsRouter()

export type CredentialsRouter = typeof credentialsRouter
