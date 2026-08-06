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
 * `queued` → signal · `provisioning`/`running`/`paused` → amber · `succeeded` → verdigris ·
 * `failed`/`capped` → rust · `needs_attention` → amber · `parked_resumable`/`cancelled` → graphite.
 */
export const WORKFLOW_STATE_PRESENTATION = {
  queued: { tone: 'signal', pulse: false },
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
 * The readout a chip shows when the caller supplies no text of its own.
 *
 * Underscores become spaces; the uppercasing is the `label-mono` token's job, not this function's.
 *
 * @param state - The workflow's state, or `undefined` for the idle chip.
 */
export const readoutForState = (state?: WorkflowState): string =>
  state === undefined ? 'idle' : state.replace(/_/g, ' ')
