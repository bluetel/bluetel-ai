import { eq } from 'drizzle-orm'

import type { SisyphusDatabase, Workflow } from '../../db'
import { workflowEvents, workflows } from '../../db'
import type { TerminalOutcome, WorkflowState } from '../../enums'
import { isTerminalState, runWorkflowTransition } from '../workflow'

/**
 * Taking a seat back from a run — the administrative half of FR-057, and the seam it needs.
 *
 * ## Why there is a port here, and why it covers only half the operation
 *
 * Releasing a lease is `apps/sisyphus-control-plane/src/credentials/lease/release.ts`, and this
 * package cannot import an application: the panel, the control plane and the executor all consume
 * it, so a dependency from here onto an app would invert the graph and leave two of the three
 * unable to build. That is the same argument `admin/credential-login.ts`, `admin/reachability.ts` and
 * `machine/credential-material.ts` each make from their own side, and the answer is the same one —
 * state what is needed, let the host supply it, and put the key on
 * {@link import('../context').SisyphusDependencies}.
 *
 * What is **not** behind the port is the other half of FR-057: resolving the affected workflow to a
 * recorded state. `workflows` is this package's own table, `workflow/transition.ts` is this
 * package's own locked-transition primitive, and a run's outcome is not a lease concern. Putting it
 * behind the port as well would have moved a decision about how a run ends into whatever object a
 * deployment happened to wire, and — the part that actually matters — it would have left the
 * contract test asserting against a recorder instead of against a workflow row.
 *
 * ## The order the two halves run in is a recovery decision
 *
 * The run is resolved **first**, and the seat is released **second**. Both orders have a window in
 * which a crash leaves one done and the other not, so the question is only which residue the
 * platform can repair:
 *
 * - **Run resolved, seat still held.** The FR-022 reconciliation sweep resolves leases whose
 *   workflow's fate is already decided, so this repairs itself on the next pass. The seat is
 *   unavailable for an interval; nothing is wrong with it.
 * - **Seat released, run still running.** Nothing repairs this. The run keeps working as an
 *   identity a second workflow may now hold, and discovers it only when its next rotation is
 *   fenced out or its next boot finds no lease.
 *
 * The first is an interval of reduced capacity and the second is the failure this whole feature
 * exists to prevent, so the order is fixed and not an implementation detail.
 *
 * It is also why `credentials.ts` refuses a force-release when **no** release port is wired, before
 * writing anything at all, rather than letting a refusing default reject halfway. A deployment that
 * cannot release a lease must not be able to fail somebody's run on the way to finding that out.
 *
 * ## What a holder of this port can and cannot do
 *
 * It can end one lease and say where the credential landed. It cannot read material, cannot name a
 * credential to release without naming the run holding it, and cannot choose the release reason:
 * `forced` is the only kind of release an administrator performs, and the platform's own FR-022
 * sweep — which records `forced` with a **null** actor — reaches `releaseLease` directly rather
 * than through here. That asymmetry is SC-015's: an administrator seizing a seat and the platform
 * tidying up after a run that no longer exists are told apart by whether an actor is recorded, and
 * a port that let a caller supply either would make the distinction a convention.
 */

/** What a forced release needs to know. Identifiers and an actor; nothing else fits. */
export interface ForceReleaseLeaseRequest {
  /** The seat being taken back, for the implementation's own assertions and for its trail entry. */
  readonly agentCredentialId: string
  /** The run holding it. Resolved by the caller from the live lease, never guessed. */
  readonly workflowId: string
  /**
   * The administrator performing it (FR-057, SC-015).
   *
   * Required, and not nullable. `credential_leases.released_by_user_id` is nullable because the
   * FR-022 sweep leaves it null, and that null is precisely what says "the platform did this, not a
   * person". A port that accepted `null` here would let an administrative act be recorded as a
   * platform one.
   */
  readonly releasedByUserId: string
}

/** Where a forced release left things. Carries no material and nothing that could reach any. */
export interface ForcedLeaseRelease {
  /**
   * `released` when a live lease was ended; `not_held` when there was none by the time the
   * implementation looked.
   *
   * Answered rather than thrown, because the caller has already read the lease and is racing an
   * ordinary teardown: a run that finished microseconds ago released its own seat, which is the
   * outcome the administrator wanted and not a failure to report as one.
   */
  readonly outcome: 'not_held' | 'released'
  readonly workflowId: string
  /** Absent on `not_held`. */
  readonly leaseId?: string
  /**
   * The state the credential ended in.
   *
   * Worth carrying because release does not repair: a seat that went `unhealthy` while it was held
   * comes back `unhealthy`, and an administrator who forced it free in order to re-log it in needs
   * to see that rather than assume the pool grew by one.
   */
  readonly credentialState?: string
}

/** The seam. One method, and no way to release anything except as an attributed administrator. */
export interface AgentCredentialLeaseReleases {
  readonly forceRelease: (request: ForceReleaseLeaseRequest) => Promise<ForcedLeaseRelease>
}

/** The reason given when a deployment has wired no lease-release seam. */
export const LEASE_RELEASE_NOT_CONFIGURED_REASON =
  'this deployment has no agent credential lease release configured, so a lease cannot be force-released'

/**
 * The seam used when a deployment has wired none. It **refuses**.
 *
 * Declared for parity with `createRefusingLoginEnvironments`, and for the composition root that
 * wants to state explicitly that it wires nothing. It is deliberately *not* what `credentials.ts`
 * falls back to: see the module note on ordering — by the time a refusing implementation could
 * reject, the run has already been resolved, and the whole point of refusing is that nothing
 * happened.
 */
export const createRefusingLeaseReleases = (): AgentCredentialLeaseReleases => ({
  forceRelease: () => Promise.reject(new Error(LEASE_RELEASE_NOT_CONFIGURED_REASON)),
})

/**
 * The outcome a force-released run is recorded under.
 *
 * `failed` rather than `cancelled`. Nobody stopped this run on its merits — its identity was taken
 * away from it, which is a failure of the platform to keep providing what the run was launched
 * with, and FR-064's `cancelled` is reserved for "a human pressed Stop" and must never be counted
 * as a failure. Recording a seizure as a cancellation would flatter the numbers in exactly the
 * direction that hides the problem.
 *
 * `needs_attention` was the other candidate and is worse: it says a human should look at *this
 * run*, when the thing that needs looking at is the seat, and the administrator is already looking
 * at it.
 */
export const FORCED_RELEASE_OUTCOME = 'failed' as const satisfies TerminalOutcome

/**
 * What is written on the run's record and its timeline. Rendered to its owner verbatim.
 *
 * It names the credential, because FR-023 forbids substituting another one and the owner's obvious
 * next question — "can it be restarted?" — has a different answer depending on whether the seat is
 * coming back. It names the administrator's own account for the same reason SC-013 wants the trail
 * attributed: a run that ended because a person acted should say which person, not "the platform".
 *
 * It carries no material and there is nowhere in it for any: both arguments are names.
 *
 * @param credentialName - The seat that was taken back.
 * @param actorDescription - How the acting administrator is identified on screen, usually an email.
 */
export const forcedReleaseOutcomeReason = (
  credentialName: string,
  actorDescription: string,
): string =>
  [
    `The agent credential ${credentialName} was force-released from this run by ${actorDescription}, so the run has been ended.`,
    'A run is never moved to a different agent credential — not across a pause, a park, a rebuild or a credential failure — so there was no seat to continue on. Relaunch it once the credential is back in service.',
  ].join(' ')

/** What {@link resolveWorkflowForForcedRelease} did. */
export interface ForcedReleaseWorkflowResolution {
  readonly workflowId: string
  /** The state the run was in when the row lock was taken. */
  readonly from: WorkflowState
  /** The state it is in now — {@link FORCED_RELEASE_OUTCOME}, or whatever it had already reached. */
  readonly state: WorkflowState
  /**
   * False when the run was already terminal and this changed nothing.
   *
   * Not an error and not a refusal. A run that finished a moment before the administrator pressed
   * the button has resolved itself, and FR-064 allows exactly one outcome in force — overwriting
   * the run's own account of how it ended with "an administrator took its seat" would replace a
   * true record with a false one.
   */
  readonly resolved: boolean
  /** The sentence written on the record, or the one already there. */
  readonly outcomeReason: string | null
}

export interface ResolveWorkflowForForcedReleaseOptions {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  /** The acting administrator, for `workflow_events.actor_user_id`. */
  readonly actorUserId: string
  /** The sentence to record. Built by {@link forcedReleaseOutcomeReason}. */
  readonly outcomeReason: string
}

/**
 * Resolve the run whose seat is being taken — the "recorded state" half of FR-057.
 *
 * Under the workflow row lock, because this is a read-decide-write over `workflows.state` and every
 * other supervision write in the platform takes the same lock for the same reason: a `stop` landing
 * concurrently and this force-release both reading `running` would produce two outcomes for one
 * run, which FR-064 forbids. `runWorkflowTransition` is that lock; see `workflow/transition.ts`.
 *
 * The state change and the timeline entry are one statement pair inside it, so a run cannot end up
 * `failed` with nothing on its timeline saying why — which is the shape a run's owner would meet as
 * "it just stopped".
 *
 * @param options - The handle, the run, the administrator and the sentence.
 * @returns What it found and what it wrote.
 * @throws {TRPCError} `NOT_FOUND` when the run no longer exists, from the shared lock helper.
 */
export const resolveWorkflowForForcedRelease = async (
  options: ResolveWorkflowForForcedReleaseOptions,
): Promise<ForcedReleaseWorkflowResolution> =>
  runWorkflowTransition({
    db: options.db,
    workflowId: options.workflowId,
    apply: async ({ writer, locked }) => {
      if (isTerminalState(locked.state)) {
        return {
          workflowId: options.workflowId,
          from: locked.state,
          state: locked.state,
          resolved: false,
          outcomeReason: locked.outcomeReason,
        }
      }

      await writer
        .update(workflows)
        .set({
          state: FORCED_RELEASE_OUTCOME,
          terminalOutcome: FORCED_RELEASE_OUTCOME,
          outcomeReason: options.outcomeReason,
        })
        .where(eq(workflows.id, options.workflowId))

      await writer.insert(workflowEvents).values({
        workflowId: options.workflowId,
        event: FORCED_RELEASE_OUTCOME,
        // `user`, and the only actor type that carries an id. A force-release is somebody's
        // decision, and recording it as `control_plane` would leave the run's timeline unable to
        // answer the first question its owner asks.
        actorType: 'user',
        actorUserId: options.actorUserId,
        detail: { reason: options.outcomeReason, from: locked.state, forcedRelease: true },
      })

      return {
        workflowId: options.workflowId,
        from: locked.state,
        state: FORCED_RELEASE_OUTCOME satisfies Workflow['state'],
        resolved: true,
        outcomeReason: options.outcomeReason,
      }
    },
  })
