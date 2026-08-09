import { createEnumGuard } from './enum-guard'

/**
 * Where an agent credential stands, as the
 * [credential state machine](../../../../specs/003-agent-credential-pool/data-model.md#credential-state-machine)
 * defines it.
 *
 * **Only `available` is selectable.** Every other member is a reason a credential is passed over,
 * and FR-029 requires the queue to report _which_ one applies rather than a bare "no capacity" — so
 * these are five distinct states rather than one `unavailable`, and the distinctions are the whole
 * point of the set. Selection (FR-034) filters on `state = 'available'` and nothing else; a value
 * added here is unselectable by default, which is the safe direction for a set whose failure mode
 * is handing one agent identity to two runs at once.
 *
 * - `awaiting_login` — registered, no material yet. `secret_id` is null and stays null until a
 *   login is proven, which is FR-008 expressed as a state rather than as a check somewhere: a
 *   credential nobody has logged in as cannot be issued to a workflow by any code path.
 * - `available` — logged in, healthy, held by nobody, and the only state selection considers.
 * - `held` — claimed under a live lease, or under a keep-alive exercise. Which of the two is on
 *   `agent_credentials.held_by`, not here, because both claim the row through the same conditional
 *   `UPDATE … WHERE state = 'available'` and it is that shared conditional — not two states — that
 *   makes the FR-038 race resolvable.
 * - `cooling_off` — the provider is refusing on a rate or usage limit. Temporary and
 *   self-clearing: the FR-076 sweep returns it to `available` past `cooling_off_until`, or on
 *   `SISYPHUS_COOLING_OFF_RETRY_MINUTES` when the provider named no time (FR-078). Nothing is
 *   raised to an administrator, because nothing needs doing.
 * - `unhealthy` — the login itself is broken and a human must act (FR-037). This alerts where
 *   `cooling_off` does not, which is why an ambiguous provider response resolves to `cooling_off`
 *   (research R5): a wrongly-cooled credential comes back by itself, a wrongly-unhealthy one waits
 *   on somebody noticing.
 * - `disabled` — withheld by an administrator (FR-006). Reachable from any state and it does
 *   **not** interrupt a live holder: disabling withdraws a credential from future selection, it
 *   does not evict the run currently using it.
 *
 * `cooling_off` and `unhealthy` are reachable from `held` as well as from a keep-alive exercise,
 * because a limit or a breakage surfaces mid-run — and neither releases the lease. FR-077 has the
 * run wait out a cooling-off; FR-023 forbids substituting another credential when unhealthy, so the
 * run fails naming this one and the lease releases through the ordinary terminal path. Release is
 * therefore not a repair: a credential that was `cooling_off` or `unhealthy` while held returns to
 * that state and not to `available`.
 */
export const CREDENTIAL_STATES = [
  'awaiting_login',
  'available',
  'held',
  'cooling_off',
  'unhealthy',
  'disabled',
] as const

export type CredentialState = (typeof CREDENTIAL_STATES)[number]

export const isCredentialState = createEnumGuard(CREDENTIAL_STATES)
