import type { WorkflowState } from '@bluetel-ai/sisyphus-api/client'
import { StateChip } from '@sisyphus-admin/components/ui'

import { formatTimestamp } from './timestamp'

/**
 * A bundle's most recent validation result (FR-148).
 *
 * Three states, and the third is the one worth being careful about:
 *
 * - **passed / failed** — a completed run, shown against the bundle version it exercised. The
 *   version matters: a pass against version 1 next to a current version 3 is a stale result, and a
 *   chip that only said "passed" would read as a guarantee about the archive in use.
 * - **in flight** — the run has been opened and has no verdict yet.
 * - **never validated** — rendered as exactly that. There is deliberately no optimistic default and
 *   no "unknown" that looks like a pass; an unvalidated bundle is a fact an admin needs, and
 *   guessing at it is the failure this component exists to avoid.
 *
 * Colour comes from the state chip's `workflow_state` mapping and nowhere else (FR-025). A
 * validation run is a machine run, so the mapping is a real one rather than a borrowed palette:
 * `succeeded` is verdigris, `failed` is rust, an in-flight run is amber and pulses. "Never
 * validated" takes the idle chip, which is graphite — the one colour not locked to a state, which
 * is precisely what the absence of a result is.
 */

/** What the platform records against a run. `null` means the run has not finished. */
export type ValidationOutcome = 'passed' | 'failed' | null

export interface ValidationSummary {
  /** The bundle version the run exercised. */
  readonly version: number
  readonly outcome: ValidationOutcome
  readonly startedAt: Date
  readonly endedAt: Date | null
}

/** Outcome to the workflow state that carries its colour. Total over the outcomes that exist. */
const STATE_FOR_OUTCOME = {
  passed: 'succeeded',
  failed: 'failed',
} satisfies Record<Exclude<ValidationOutcome, null>, WorkflowState>

interface ValidationResultProps {
  /** Omitted when the bundle has never been validated. */
  readonly validation?: ValidationSummary
}

export const ValidationResult = ({ validation }: ValidationResultProps) => {
  if (validation === undefined) {
    return (
      <span className="gap-tight flex items-center">
        <StateChip>never validated</StateChip>
      </span>
    )
  }

  const { outcome, version, startedAt, endedAt } = validation
  const state: WorkflowState = outcome === null ? 'running' : STATE_FOR_OUTCOME[outcome]
  const readout = outcome ?? 'validating'
  const at = endedAt ?? startedAt

  return (
    <span className="gap-tight flex items-center">
      <StateChip state={state}>{`${readout} v${String(version)}`}</StateChip>
      <span className="type-data-mono text-graphite">{formatTimestamp(at)}</span>
    </span>
  )
}
