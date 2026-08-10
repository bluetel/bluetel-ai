import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'

/**
 * The state chip's colour derives from `workflow_state`. It is never an ad-hoc choice at the call
 * site (FR-025, FR-030).
 *
 * This module is the whole of that derivation. It imports the enum from
 * `@bluetel-ai/sisyphus-api/client` — the browser-safe subpath — so the panel and the contract
 * cannot disagree about what states exist, and it exposes no way to ask for a colour directly.
 *
 * **What happens when a new state is added.** {@link WORKFLOW_STATE_PRESENTATION} is checked with
 * `satisfies Record<WorkflowState, StatePresentation>`, so a new member of `WORKFLOW_STATES` with
 * no entry here is a `tsc --noEmit` failure — the build breaks at the map, naming the state,
 * before anything renders. It cannot fall through to a default, because there is no default: the
 * lookup is a total function over the enum. The colocated test asserts the same property at run
 * time by walking `WORKFLOW_STATES`, so the guarantee survives a `satisfies` being weakened.
 */

/** The five colours a chip may take. Four are token names; there is no sixth and no free-form value. */
export const STATE_TONES = ['signal', 'amber', 'verdigris', 'rust', 'graphite'] as const

export type StateTone = (typeof STATE_TONES)[number]

/** How a state presents: its colour, and whether its LED pulses. */
export interface StatePresentation {
  tone: StateTone
  /**
   * The LED pulses only while a machine is doing work — the pulse is the system's one looping
   * animation and it means nothing else. `paused` and `queued` are amber and signal respectively
   * but nothing is running, so they hold steady.
   */
  pulse: boolean
}

/**
 * The mapping table from `design-tokens.md`, encoded once.
 *
 * `queued`/`awaiting_credential` → signal · `provisioning`/`running`/`paused` → amber ·
 * `succeeded` → verdigris · `failed`/`capped` → rust · `needs_attention` → amber ·
 * `parked_resumable`/`cancelled` → graphite.
 */
export const WORKFLOW_STATE_PRESENTATION = {
  queued: { tone: 'signal', pulse: false },
  /**
   * Signal and steady, alongside `queued` rather than alongside `needs_attention` or `failed`.
   *
   * The run is admitted and alive; it simply holds no agent credential yet, and 003/FR-025 means it
   * holds no instance and burns no compute either. Nothing is wrong and nobody has to act, so amber
   * would be a lie about severity and rust a lie about the outcome — this run is going to start.
   * Signal is the colour this system already gives to "admitted, waiting its turn", and the point of
   * the state is that the *cause* of the wait differs from `queued`, not the situation. The lamp
   * holds steady because no machine is working: a pulse here would animate a run whose billed
   * compute is exactly zero (003/SC-004).
   *
   * **Not notifiable (003/FR-079).** Waiting for a credential is reported in the workflow view and
   * nowhere else — it must not be pushed to the run's owner, because it clears on its own when a
   * seat frees. Nothing in this module can raise a notification, and that is on purpose: this file
   * decides colour and readout only. The notification vocabulary maps this state to no event in
   * `@bluetel-ai/sisyphus-notify`, and it must stay that way.
   */
  awaiting_credential: { tone: 'signal', pulse: false },
  provisioning: { tone: 'amber', pulse: true },
  running: { tone: 'amber', pulse: true },
  paused: { tone: 'amber', pulse: false },
  parked_resumable: { tone: 'graphite', pulse: false },
  succeeded: { tone: 'verdigris', pulse: false },
  failed: { tone: 'rust', pulse: false },
  capped: { tone: 'rust', pulse: false },
  cancelled: { tone: 'graphite', pulse: false },
  needs_attention: { tone: 'amber', pulse: false },
} satisfies Record<WorkflowState, StatePresentation>

/**
 * The idle case — a chip with no state behind it yet. Graphite, because graphite is the one colour
 * in the palette that is not locked to a machine state and therefore reports the absence of one.
 */
export const IDLE_PRESENTATION: StatePresentation = { tone: 'graphite', pulse: false }

/**
 * Resolve how a state presents.
 *
 * @param state - The workflow's state, or `undefined` for the idle chip.
 * @returns The tone and pulse for that state. Total over the enum — never a fallback.
 */
export const presentationForState = (state?: WorkflowState): StatePresentation =>
  state === undefined ? IDLE_PRESENTATION : WORKFLOW_STATE_PRESENTATION[state]

/**
 * States whose enum name, de-underscored, does not say enough on a chip.
 *
 * There is exactly one, and it needs a reason to be here rather than a preference. 003/SC-006 says
 * an engineer must be able to tell **from the workflow view alone and without assistance** that a
 * run is waiting for an agent credential. The de-underscored name reads "awaiting credential", and
 * on a platform that also installs non-agent credentials from the setup bundle (003/FR-048) that
 * invites exactly the wrong reading — that some secret is missing from the run's own configuration
 * and the engineer has to go and supply it. Naming the agent credential says instead that the run is
 * queued behind a shared seat and will start when one frees, which is the difference between waiting
 * and acting.
 *
 * This is a chip readout, not the explanation. How long it has waited and which credential groups
 * were searched (003/FR-029) belong on the workflow view, and that surface is not built yet.
 *
 * Anything not listed here is de-underscored, which is right for every other state: `running` and
 * `needs attention` describe themselves.
 */
const STATE_READOUT_OVERRIDES: Partial<Record<WorkflowState, string>> = {
  awaiting_credential: 'awaiting agent credential',
}

/**
 * The readout a chip shows when the caller supplies no text of its own.
 *
 * Underscores become spaces unless {@link STATE_READOUT_OVERRIDES} has something more legible to
 * say; the uppercasing is the `label-mono` token's job, not this function's.
 *
 * @param state - The workflow's state, or `undefined` for the idle chip.
 */
export const readoutForState = (state?: WorkflowState): string =>
  state === undefined ? 'idle' : (STATE_READOUT_OVERRIDES[state] ?? state.replace(/_/g, ' '))
