import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import {
  agentCredentials,
  configurationAudit,
  credentialLeases,
  workflows,
} from '@bluetel-ai/sisyphus-api/db'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { selectFor } from '../allocate'

/**
 * Claiming a seat — the Acquire half of
 * [the allocation protocol](../../../../../specs/003-agent-credential-pool/contracts/allocation-protocol.md#acquire).
 *
 * **One transaction, no exceptions, and there is no seam inside it.** The conditional update that
 * claims the credential, the lease row that records the claim, the workflow's back-reference and
 * the audit entry are four writes that are only correct together. `credential-store.ts` in the API
 * package deliberately offers no acquire/release pair for this reason — a store function that
 * returned control between two of these steps would be a place the exclusivity guarantee could
 * leak — and this module honours that rather than reinventing it one layer up.
 *
 * ## Why two racing acquisitions cannot both commit
 *
 * There are two independent reasons, and both are the database's rather than this code's.
 *
 * 1. **The conditional `UPDATE … WHERE id = :selected AND state = 'available'`.** The loser's
 *    update blocks on the winner's row lock, and when the winner commits the loser re-evaluates its
 *    `WHERE` against the new row version, sees `held`, and matches nothing. Zero rows is not an
 *    error — it is the answer — so the attempt rolls back and re-selects. This is also how a
 *    workflow reservation and a keep-alive exercise resolve their contention for one idle row
 *    (FR-038): both claim through the *same* conditional, so exactly one of them updates anything.
 * 2. **`credential_leases_live_key`**, the partial unique index on `(agent_credential_id) WHERE
 *    released_at IS NULL`. The conditional update makes the index unreachable in the ordinary race,
 *    which is a good property right up until the credential row and the lease table disagree — a
 *    forced release that failed partway, a manual repair, the window the FR-039 sweep exists to
 *    close. Then the row genuinely is `available`, the update matches, and the index is the only
 *    thing between the second workflow and a shared identity. It is not a belt-and-braces check; it
 *    is the guarantee (FR-017, SC-003), and `acquire.test.ts` proves it by removing it and watching
 *    two live leases appear.
 *
 * A loss on either is retried by re-selecting, exactly as the contract says. Retrying is bounded:
 * under drift, selection keeps returning the same credential and the same insert keeps failing, so
 * an unbounded loop would spin forever inside admission rather than fail visibly. After
 * {@link DEFAULT_MAX_ACQUISITION_ATTEMPTS} the attempt gives up as {@link ContendedAcquisition},
 * which is a state for the caller to retry its job from, not an error — the pool is not broken, it
 * would not settle now.
 *
 * ## Why the audit row is written before the lease, inside the transaction
 *
 * FR-058 wants every acquisition in the append-only trail and SC-013 wants it for the retention
 * period, and the failure mode that would satisfy both on a good day is an audit write outside the
 * transaction: it would survive a rolled-back acquisition and record a lease that never existed,
 * which is worse than no trail because it is a trail that cannot be believed. Inside the
 * transaction it lives or dies with the claim.
 *
 * Ordering it **first**, ahead of the lease insert, is deliberate too. It means the two writes
 * likeliest to fail — the unique index on the lease, and the foreign key on the workflow — both
 * take the audit row down with them, which is the property the tests can actually observe. The cost
 * is that the entry cannot name the lease id; the entity is the credential and never the lease
 * anyway (see `AUDITED_ENTITY_TYPES`), and the workflow and fence in `detail` are what makes an
 * entry legible later.
 *
 * ## What this does not do
 *
 * It does not touch `workflows.state`. Admission owns that column — T046 calls this from inside the
 * admission lock, immediately *before* its own `provisioning` write, and the FR-024 waiting path
 * needs `awaiting_credential` there instead. Two writers on one state column is how a workflow ends
 * up `provisioning` with no seat, and the caller is the one that knows which of the two it wanted.
 */

/** The exclusivity gate, by name. Callers match on this rather than on a driver error message. */
export const LEASE_EXCLUSIVITY_INDEX = 'credential_leases_live_key'

/** FR-015's other half: a workflow holds at most one live lease. */
export const WORKFLOW_EXCLUSIVITY_INDEX = 'credential_leases_workflow_live_key'

/**
 * `agent_credentials.held_by` while a workflow holds the seat.
 *
 * The other value is `keep_alive`, and it is written by the liveness phase against the same
 * conditional update. Named here rather than typed as a literal at the call site so the two
 * claimants cannot come to spell the discriminator differently (FR-038, FR-074).
 */
export const CREDENTIAL_HOLDER_WORKFLOW = 'workflow'

/**
 * How many times an acquisition re-selects before giving up.
 *
 * Sized against the pool rather than against patience: every failed attempt means some other
 * transaction took the credential this one had selected, and a pool of tens of credentials cannot
 * produce more than a handful of those before a seat is either taken or genuinely gone. A larger
 * number would not find capacity that exists; it would only spend longer discovering drift.
 */
export const DEFAULT_MAX_ACQUISITION_ATTEMPTS = 16

/** The workflow now holds this credential, and it alone does. */
export interface AcquiredCredential {
  readonly outcome: 'acquired'
  readonly workflowId: string
  readonly agentCredentialId: string
  readonly credentialGroupId: string
  readonly leaseId: string
  /** The value this acquisition raised the credential's fence to, and the lease carries (R9). */
  readonly fence: number
  readonly attempts: number
}

/**
 * The workflow already holds a seat (FR-015). Not an error: admission is a job, jobs are retried,
 * and a retry that had quietly taken a second identity is the failure this reports instead of.
 */
export interface AlreadyHeldCredential {
  readonly outcome: 'already_held'
  readonly workflowId: string
  readonly agentCredentialId: string
  readonly leaseId: string
}

/**
 * Nothing in the workflow's attached groups is available. A wait, not a failure (FR-024) — the
 * caller puts the workflow in `awaiting_credential` and provisions nothing (FR-025, SC-004).
 */
export interface NoCredentialAvailable {
  readonly outcome: 'none_available'
  readonly workflowId: string
  readonly attempts: number
}

/**
 * The pool would not settle within `maxAttempts`.
 *
 * Distinct from {@link NoCredentialAvailable} because the remedy differs: there may well be free
 * capacity, and this attempt kept losing to other claimants or to a credential whose row and lease
 * disagree. The caller retries the job; the FR-039 sweep repairs the drift underneath it. Reporting
 * this as "none available" would put a workflow into a wait it should not be in, and throwing would
 * make a busy pool look like a defect.
 */
export interface ContendedAcquisition {
  readonly outcome: 'contended'
  readonly workflowId: string
  readonly attempts: number
}

export type AcquisitionOutcome =
  | AcquiredCredential
  | AlreadyHeldCredential
  | ContendedAcquisition
  | NoCredentialAvailable

export interface AcquireCredentialOptions {
  /**
   * A pooled handle, **not** a transaction. Acquisition opens and commits its own, and re-selecting
   * after a loss depends on the failed attempt having actually rolled back.
   */
  readonly db: SisyphusDatabase
  readonly workflowId: string
  /** Defaults to {@link DEFAULT_MAX_ACQUISITION_ATTEMPTS}. */
  readonly maxAttempts?: number
}

/**
 * The first row, honestly typed. See the same helper in `allocate/select.ts` for why it exists.
 */
const firstRow = <TRow>(rows: readonly TRow[]): TRow | undefined => rows[0]

/**
 * Thrown to roll the attempt back when the conditional update matches nothing.
 *
 * Drizzle commits whatever the callback returns, so "abandon this transaction" has to be a throw.
 * A dedicated class rather than a plain `Error` because the catch below has to tell this apart from
 * a real failure, and matching on a message is how a genuine error ends up silently retried.
 */
class LostTheConditionalUpdate extends Error {
  constructor() {
    super('The selected credential was no longer available. Rolling back to re-select.')
    this.name = 'LostTheConditionalUpdate'
  }
}

/**
 * The index a write was refused by, or `undefined` if it failed for some other reason.
 *
 * Read from Postgres's own `constraint_name` rather than from the error message, and the difference
 * is the whole reliability of the retry: Drizzle wraps the driver error in one whose `message` is
 * the failing SQL, so matching on text would treat a null violation or a missing foreign key as a
 * lost race and retry it forever. `cause` is read structurally because the driver error is untyped.
 */
const refusedByIndex = (error: unknown): string | undefined => {
  const candidates = [error, (error as { cause?: unknown } | undefined)?.cause]
  for (const candidate of candidates) {
    const name = (candidate as { constraint_name?: unknown } | undefined)?.constraint_name
    if (typeof name === 'string') return name
  }
  return undefined
}

/** The live lease a workflow already holds, if it holds one. */
const liveLeaseFor = async (
  db: SisyphusDatabase,
  workflowId: string,
): Promise<{ id: string; agentCredentialId: string } | undefined> =>
  firstRow(
    await db
      .select({ id: credentialLeases.id, agentCredentialId: credentialLeases.agentCredentialId })
      .from(credentialLeases)
      .where(and(eq(credentialLeases.workflowId, workflowId), isNull(credentialLeases.releasedAt)))
      .limit(1),
  )

/**
 * Reserve one credential for one workflow, or say why not.
 *
 * Called at admission, **before any compute is provisioned** (FR-016, T046): by the time bootstrap
 * runs, the claim is already guaranteed, so the instance's `credential_install` phase can fail on
 * transport but never on availability — and a workflow that gets nothing here has cost nothing.
 *
 * @param options - The database handle, the workflow, and how hard to try.
 * @returns Which of the four things happened.
 * @throws If `maxAttempts` is not a positive integer, or if any database failure other than a lost
 *   race occurs. A caller seeing a throw here is looking at a broken database, not a busy pool.
 */
export const acquireCredential = async (
  options: AcquireCredentialOptions,
): Promise<AcquisitionOutcome> => {
  const { db, workflowId } = options
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ACQUISITION_ATTEMPTS

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `maxAttempts must be a positive integer; received ${String(maxAttempts)}. An acquisition that never attempts anything would report an empty pool for a full one.`,
    )
  }

  const alreadyHeld = async (): Promise<AlreadyHeldCredential | undefined> => {
    const existing = await liveLeaseFor(db, workflowId)
    return existing === undefined
      ? undefined
      : {
          outcome: 'already_held',
          workflowId,
          agentCredentialId: existing.agentCredentialId,
          leaseId: existing.id,
        }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const held = await alreadyHeld()
    if (held !== undefined) return held

    try {
      const claimed = await db.transaction(async (tx) => {
        // Selection inside the transaction, so the row it names is read from the same snapshot the
        // conditional update is about to test. It takes no lock: two callers being offered the same
        // credential is expected, and the update below is what resolves it.
        const selected = await selectFor(tx, { workflowId })
        if (selected === undefined) return undefined

        const updated = firstRow(
          await tx
            .update(agentCredentials)
            .set({
              state: 'held',
              heldBy: CREDENTIAL_HOLDER_WORKFLOW,
              // The fence is raised here and nowhere else. It is what makes a displaced holder's
              // later rotation writes rejectable without anyone deciding whether it is dead (R9).
              fence: sql`${agentCredentials.fence} + 1`,
              lastUsedAt: new Date(),
            })
            .where(
              and(
                eq(agentCredentials.id, selected.agentCredentialId),
                eq(agentCredentials.state, 'available'),
              ),
            )
            .returning({ fence: agentCredentials.fence }),
        )

        if (updated === undefined) {
          // Somebody else took it between the select and here. Zero rows is the answer, not a
          // failure — roll back and re-select against a pool that now excludes it.
          throw new LostTheConditionalUpdate()
        }

        // First, so that every later failure in this transaction takes it with it. See the module
        // note: an audit entry that outlived its acquisition would record a lease that never was.
        await tx.insert(configurationAudit).values({
          actorUserId: null,
          entityType: 'agent_credential',
          entityId: selected.agentCredentialId,
          action: 'leased',
          detail: {
            workflowId,
            credentialGroupId: selected.credentialGroupId,
            credentialGroupName: selected.credentialGroupName,
            fence: updated.fence,
          },
        })

        const lease = firstRow(
          await tx
            .insert(credentialLeases)
            .values({
              agentCredentialId: selected.agentCredentialId,
              workflowId,
              fence: updated.fence,
            })
            .returning({ id: credentialLeases.id }),
        )

        if (lease === undefined) {
          throw new Error(
            `Inserting a credential lease for workflow ${workflowId} returned no row. Committing here would leave a credential held under a lease that does not exist, which nothing downstream could release.`,
          )
        }

        // FR-059: the run's own record names the identity it used, for the retention period. Never
        // cleared on release — a lease says who held a seat, this says what the run charged to it.
        await tx
          .update(workflows)
          .set({ agentCredentialId: selected.agentCredentialId })
          .where(eq(workflows.id, workflowId))

        return {
          outcome: 'acquired',
          workflowId,
          agentCredentialId: selected.agentCredentialId,
          credentialGroupId: selected.credentialGroupId,
          leaseId: lease.id,
          fence: updated.fence,
          attempts: attempt,
        } satisfies AcquiredCredential
      })

      if (claimed === undefined) {
        return { outcome: 'none_available', workflowId, attempts: attempt }
      }
      return claimed
    } catch (error) {
      if (error instanceof LostTheConditionalUpdate) continue

      const index = refusedByIndex(error)
      if (index === LEASE_EXCLUSIVITY_INDEX) {
        // The credential row said `available` while a live lease named it. The index refused the
        // second holder, which is exactly its job; re-select, and let the sweep repair the drift.
        continue
      }
      if (index === WORKFLOW_EXCLUSIVITY_INDEX) {
        // This workflow was granted a seat concurrently — by a retry of the same job, or by the
        // grant-on-release path. Report the seat it has rather than competing with ourselves.
        const raced = await alreadyHeld()
        if (raced !== undefined) return raced
        continue
      }
      throw error
    }
  }

  return { outcome: 'contended', workflowId, attempts: maxAttempts }
}
