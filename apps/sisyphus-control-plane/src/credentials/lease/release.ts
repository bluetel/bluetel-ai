import type {
  AgentCredential,
  CredentialLease,
  SisyphusDatabase,
} from '@bluetel-ai/sisyphus-api/db'
import { agentCredentials, configurationAudit, credentialLeases } from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNull, sql } from 'drizzle-orm'

/**
 * Giving a seat back — the Release half of
 * [the allocation protocol](../../../../../specs/003-agent-credential-pool/contracts/allocation-protocol.md#release).
 *
 * **Release does not repair.** A credential that went `cooling_off` or `unhealthy` while it was
 * held comes back to *that* state, not to `available`. The obvious statement — `SET state =
 * 'available'` — is right in the ordinary case and catastrophic in the two that matter: a
 * credential the provider is rate limiting, or one whose login is broken, would be handed to the
 * next workflow that asked, and that run would fail for a reason nothing in its own history
 * explains. FR-033 and SC-010 both turn on this one conditional, so it is written as a rule rather
 * than guarded at the call site.
 *
 * `held_by` is cleared unconditionally, and that is not an inconsistency with the above. The two
 * columns answer different questions: `state` is whether the credential is usable, and `held_by` is
 * who is using it. Nobody is, once the lease is released — leaving it set would show a finished run
 * against the seat in the pool view (FR-074), which is the screen an administrator uses to work out
 * why the pool is exhausted.
 *
 * ## When this is called, and when it emphatically is not
 *
 * Only on terminal state or a forced release (FR-019). **Not** on pause, **not** on park, and not
 * when an execution environment is destroyed — a lease belongs to the workflow, not to any instance
 * (FR-018), and it survives every environment the run ever has. That rule lives in the callers
 * (T047's teardown, T048's failed provisioning, T049's sweep) because it is a rule about *when*;
 * what this module guarantees is that when it is called, the seat, the lease and the trail all move
 * together.
 *
 * It is safe to call twice. Teardown is a job and jobs are retried; the `released_at IS NULL`
 * predicate means a second call matches no lease, writes nothing, and reports
 * {@link NoLiveLease} — rather than appending a second audit entry, or freeing a seat some other
 * run has since taken.
 *
 * ## What it does not touch
 *
 * The fence. Only acquisition raises it (R9), and a release that bumped it would invalidate a
 * rotation the departing holder had already sent and not yet had persisted — which FR-032 says must
 * still land, because the credential's future usability depends on it.
 *
 * `workflows.agent_credential_id`. FR-059 says the run's record names the identity it used for the
 * retention period; clearing it would erase the run's own history and break the join that makes
 * per-credential spend answerable (FR-055).
 */

/**
 * `terminal | forced | login_replaced`, taken from the column rather than restated.
 *
 * Read off `credential_leases.release_reason` the way `workflow-fixtures.ts` reads
 * `Workflow['state']`, so the vocabulary has one definition. `NonNullable` because the column is
 * nullable for exactly one reason — null is a *live* lease — and a release always has a reason.
 */
export type ReleaseReason = NonNullable<CredentialLease['releaseReason']>

/** Where a credential ends up. Taken from the column, for the same reason as above. */
export type CredentialState = AgentCredential['state']

/** What release needs from a handle. It opens its own transaction, so this is the pooled client. */
export interface ReleaseLeaseOptions {
  readonly db: SisyphusDatabase
  readonly workflowId: string
  /** `terminal` | `forced` | `login_replaced` — the only account of how the seat came free. */
  readonly reason: ReleaseReason
  /**
   * The administrator who took the seat back (FR-057). Set **only** when a person did it: the
   * FR-022 sweep also records `forced` and leaves this null, and that null is what distinguishes an
   * administrator seizing a seat from the platform tidying up after a run that no longer exists
   * (SC-015).
   */
  readonly releasedByUserId?: string | null
}

/** The lease ended and the credential is no longer held by this workflow. */
export interface ReleasedLease {
  readonly outcome: 'released'
  readonly workflowId: string
  readonly agentCredentialId: string
  readonly leaseId: string
  readonly reason: ReleaseReason
  /**
   * Where the credential ended up. `available` in the ordinary case; whatever it already was if it
   * had become unwell while held, because release does not repair.
   */
  readonly credentialState: CredentialState
}

/** There was no live lease to release. A retried teardown, or a run that never got a seat. */
export interface NoLiveLease {
  readonly outcome: 'not_held'
  readonly workflowId: string
}

export type ReleaseOutcome = NoLiveLease | ReleasedLease

/** The first row, honestly typed. See the same helper in `allocate/select.ts`. */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * `released` and `force_released` are separate events for the same reason `replaced` is separate
 * from `updated`: "was anything taken off a run?" is the first question asked after a run ends
 * unexpectedly, and a trail that spelled both the same way could not answer it.
 */
const auditActionFor = (reason: ReleaseReason): 'force_released' | 'released' =>
  reason === 'forced' ? 'force_released' : 'released'

/**
 * Release the seat one workflow holds.
 *
 * @param options - The handle, the workflow, why the seat came free, and who took it if anyone.
 * @returns The release, or {@link NoLiveLease} when the workflow held nothing.
 */
export const releaseLease = async (options: ReleaseLeaseOptions): Promise<ReleaseOutcome> => {
  const { db, reason, workflowId } = options
  const releasedByUserId = options.releasedByUserId ?? null

  return db.transaction(async (tx) => {
    const lease = firstRow(
      await tx
        .update(credentialLeases)
        .set({ releasedAt: new Date(), releaseReason: reason, releasedByUserId })
        // `released_at IS NULL` is the whole idempotence story: a second call matches no row.
        .where(
          and(eq(credentialLeases.workflowId, workflowId), isNull(credentialLeases.releasedAt)),
        )
        .returning({
          id: credentialLeases.id,
          agentCredentialId: credentialLeases.agentCredentialId,
        }),
    )

    if (lease === undefined) {
      return { outcome: 'not_held', workflowId } satisfies NoLiveLease
    }

    const credential = firstRow(
      await tx
        .update(agentCredentials)
        .set({
          // The contract writes this as `SET state = 'available' … AND state = 'held'`. It is a
          // `CASE` here so that one statement can also clear `held_by`, which has to happen in
          // every branch — two statements would say the same thing twice and let them drift.
          state: sql`case when ${agentCredentials.state} = 'held' then 'available'::credential_state else ${agentCredentials.state} end`,
          heldBy: null,
        })
        .where(eq(agentCredentials.id, lease.agentCredentialId))
        .returning({ state: agentCredentials.state }),
    )

    if (credential === undefined) {
      throw new Error(
        `Lease ${lease.id} named agent credential ${lease.agentCredentialId}, which does not exist. The lease's foreign key makes that impossible without the row having been deleted underneath it, and committing here would report a seat freed that nothing owns.`,
      )
    }

    // In the same transaction as the release it describes (FR-058). Outside it, a rolled-back
    // release would leave the trail claiming a seat came free while the lease was still live.
    await tx.insert(configurationAudit).values({
      actorUserId: releasedByUserId,
      entityType: 'agent_credential',
      entityId: lease.agentCredentialId,
      action: auditActionFor(reason),
      detail: {
        workflowId,
        leaseId: lease.id,
        releaseReason: reason,
        // Recorded because it is the surprising one: an administrator reading the trail needs to
        // see that the seat did *not* return to the pool, and why.
        credentialState: credential.state,
      },
    })

    return {
      outcome: 'released',
      workflowId,
      agentCredentialId: lease.agentCredentialId,
      leaseId: lease.id,
      reason,
      credentialState: credential.state,
    } satisfies ReleasedLease
  })
}
