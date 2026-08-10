import { createEnumGuard } from './enum-guard'

/**
 * Why a credential lease stopped being live.
 *
 * A lease row is never mutated except to write its release (FR-015, FR-019), so this value is the
 * only account of how a seat came free — and FR-058 puts it in the append-only configuration audit
 * alongside the release. It is recorded rather than inferred because the three cases are
 * indistinguishable afterwards from the row itself: all three leave `released_at` set and the
 * credential held by nobody, and only this column says whether that was routine, imposed, or a
 * consequence of the credential being re-logged-in underneath its holder.
 *
 * - `terminal` — the ordinary case, and per FR-019 the only one that happens on its own. The
 *   workflow reached a terminal state and gave the seat back. Pausing, parking and the destruction
 *   of an execution environment are **not** this: the lease belongs to the workflow, not to any
 *   instance (FR-018), so it survives all three.
 * - `forced` — an administrator took the seat back from a live holder (FR-057), which is also the
 *   reason the reconciliation sweep records when it resolves a lease whose workflow is terminal or
 *   gone (FR-022). Acquisition raises `agent_credentials.fence`, so the displaced holder's
 *   subsequent rotation writes are rejected as stale rather than silently landing on material the
 *   new holder now owns — the fence is what makes a forced release safe against a holder that is
 *   merely partitioned rather than dead (FR-020, research R9). `released_by_user_id` is set only on
 *   this reason, and only when a person rather than the sweep did it (SC-015).
 * - `login_replaced` — the credential was re-logged-in (FR-010, FR-072) and the material behind the
 *   lease is no longer the material the holder was issued. Distinct from `forced` because nothing
 *   was wrong with the lease: it is the credential underneath it that changed, and reporting that
 *   as an administrator seizing the seat would misdescribe what happened to the run.
 *
 * Null on a live lease. The column is nullable for exactly that reason and for no other — a
 * released lease without a reason is a defect, not a fourth case.
 */
export const CREDENTIAL_RELEASE_REASONS = ['terminal', 'forced', 'login_replaced'] as const

export type CredentialReleaseReason = (typeof CREDENTIAL_RELEASE_REASONS)[number]

export const isCredentialReleaseReason = createEnumGuard(CREDENTIAL_RELEASE_REASONS)
