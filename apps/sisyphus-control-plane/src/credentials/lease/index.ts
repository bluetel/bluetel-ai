/**
 * Leasing — taking a seat, giving it back, and refusing a write from a holder that no longer has
 * one.
 *
 * The three modules behind this barrel are the mechanism the whole of 003 exists to provide. A
 * workflow reserves exactly one credential at admission, holds it for its entire lifetime through
 * pauses, parks and every execution environment it ever has, writes its rotations through under a
 * fence, and releases it at terminal state.
 *
 * **Exclusivity is a database guarantee, not an application one.** `acquireCredential` is one
 * transaction: a conditional `UPDATE … WHERE state = 'available'` that raises the fence, an audit
 * entry, the lease row, and the workflow's back-reference. Two racing acquisitions cannot both
 * commit — one loses on the conditional, and where the credential row and the lease table disagree,
 * the other loses on `credential_leases_live_key` (FR-017, SC-003). Nothing here exposes the steps
 * separately, because a caller able to run them apart is a caller able to lose the guarantee.
 *
 * **Release is not a repair**, and `releaseLease` is where that rule lives: a credential that went
 * `cooling_off` or `unhealthy` while held returns to that state rather than to the pool.
 *
 * **The fence decides rotations, and nothing else does.** `persistRotation` compares the writer's
 * fence against the credential's and consults neither the lease's liveness nor the workflow's state
 * — which is what makes FR-032 (a rotation arriving after its run has terminated is still stored)
 * fall out of the design rather than needing a case of its own.
 *
 * `pool-fixtures.ts` lives in `../allocate/` and is exported from neither barrel: it is test
 * support, and a scratch-database seeder one import away from the allocator is exactly what a
 * barrel is for keeping out.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export {
  acquireCredential,
  CREDENTIAL_HOLDER_WORKFLOW,
  DEFAULT_MAX_ACQUISITION_ATTEMPTS,
  LEASE_EXCLUSIVITY_INDEX,
  WORKFLOW_EXCLUSIVITY_INDEX,
} from './acquire'
export type {
  AcquireCredentialOptions,
  AcquiredCredential,
  AcquisitionOutcome,
  AlreadyHeldCredential,
  ContendedAcquisition,
  NoCredentialAvailable,
} from './acquire'

export { releaseLease } from './release'
export type { NoLiveLease, ReleaseLeaseOptions, ReleaseOutcome, ReleasedLease } from './release'

export { isFenceCurrent, persistRotation, STALE_FENCE } from './fence'
export type { FenceComparison, FenceReader, PersistRotationOptions, RotationOutcome } from './fence'
