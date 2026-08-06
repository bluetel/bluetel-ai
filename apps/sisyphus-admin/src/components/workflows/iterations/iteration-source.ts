import type { RouterOutputs } from '@sisyphus-admin/trpc'

import type { IterationRecord } from './iteration-readouts'

/**
 * The bridge from `workflow.iterations` to what the card renders.
 *
 * `IterationRecord` was written by hand while no interactive read existed — the machine surface
 * recorded iterations and nothing served them to a person. That procedure now exists, so the type
 * is pinned to it here rather than left as a mirror: `IterationPass` is the procedure's own output
 * type, so a column renamed in the API is a compile error in this file instead of a field that
 * silently reads `undefined` on the screen.
 *
 * The two shapes differ deliberately and this is the only place that knows it. The procedure
 * returns the stored row (`reviewVerdict`, nullable, named as the column is); the card wants the
 * flat reading (`verdict`) with its findings already attached. Neither should be bent towards the
 * other — the row is the record and the readout is the presentation.
 */
export type IterationPass = RouterOutputs['workflow']['iterations'][number]

/**
 * Flatten each pass into the record the readouts consume.
 *
 * Order is the procedure's — by `ordinal`, oldest first — and is never re-sorted here. A timeline
 * the panel reordered is no longer the record.
 */
export const toIterationRecords = (passes: readonly IterationPass[]): readonly IterationRecord[] =>
  passes.map(({ iteration, findings }) => ({
    id: iteration.id,
    ordinal: iteration.ordinal,
    // `null` is a real state and not a missing value: a pass that started and has not been reviewed
    // yet has no verdict, and the readout renders that as running rather than as failed.
    verdict: iteration.reviewVerdict,
    startedAt: iteration.startedAt,
    endedAt: iteration.endedAt,
    // `null` in a column means "no anchor recorded"; the card's contract spells that `undefined`.
    // Converted here rather than by widening the card to accept both, so there is one
    // representation of an absent anchor on the rendering side of the boundary.
    findings: findings.map((finding) => ({
      severity: finding.severity,
      summary: finding.summary,
      filePath: finding.filePath ?? undefined,
      line: finding.line ?? undefined,
      workflowEntryId: finding.workflowEntryId ?? undefined,
    })),
  }))
