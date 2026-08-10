/**
 * Credential health — deciding what a provider's refusal means, and writing that decision down.
 *
 * Two modules, one decision each, and the split between them is the design. `classify.ts` is a pure
 * function of a recorded response: it chooses between `cooling_off` and `unhealthy`, and it is the
 * only place in the platform that chooses. `transition.ts` applies a verdict to the row — inside one
 * transaction, with a `state_changed` audit entry naming both states (FR-058) — and is the only
 * place a credential's state changes for a health reason. Neither reaches into a provider, and
 * nothing behind this barrel does: the provider interaction is `../liveness/exercise.ts`, which
 * calls this with what it got back.
 *
 * **The asymmetry between the two states is the whole point.** A `cooling_off` credential is alive
 * and busy: it returns to the pool by itself on the FR-076 sweep, and nothing is raised to anybody
 * (SC-019). An `unhealthy` credential is broken and stays out until a person repairs it, so it is
 * alerted (FR-037, FR-056). An ambiguous response therefore resolves to `cooling_off`, because the
 * two mistakes cost very different amounts — research R5, and `classify.ts` says so at length.
 *
 * `returnFromCoolingOff` is the way back, exported here rather than written into the sweep that
 * calls it so that both directions produce the same shape of trail entry.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export { classifyProviderResponse } from './classify'
export type { HealthVerdict, ProviderResponse, ProviderSignal } from './classify'

export { applyHealthVerdict, returnFromCoolingOff, VERDICT_SOURCE_STATES } from './transition'
export type {
  AppliedTransition,
  ApplyHealthVerdictOptions,
  CredentialAlerter,
  HealthTransitionOutcome,
  ReturnFromCoolingOffOptions,
  UnchangedTransition,
  UnhealthyCredentialAlert,
} from './transition'
