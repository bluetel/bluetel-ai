import { createEnumGuard } from './enum-guard'

/**
 * How a bundle validation run ended (FR-147, FR-148).
 *
 * Two values and no third, because a validation is a proof rather than a run: the bootstrap phases
 * either all reached `succeeded` or one of them did not, and there is no outcome in between for a
 * `passed` to be qualified by. In particular there is no `timed_out` here — a validation abandoned
 * at its budget is `failed`, with the phase that hung recorded in `validation_runs.phase_results`,
 * because "the bundle could not be proved" is the same answer to the only question anybody asks of
 * this table. The distinction FR-146 draws between a failure and a timeout is drawn *per phase*, by
 * {@link BOOTSTRAP_PHASE_OUTCOMES}, which is where it is actionable.
 *
 * ## Why this tuple exists at all, when the pgEnum already did
 *
 * `validation_outcome` was the one `pgEnum` in `src/db/schema/enums.ts` declared from a literal
 * array with no mirroring tuple here, which broke that module's own stated rule: a set that has a
 * consumer outside the database lives in this directory, and the `pgEnum` is generated **from** it.
 * That rule is not tidiness. `machine.reportValidation` derives the outcome from the phases the
 * executor reports rather than trusting a value on the wire, and the panel renders it (FR-148) —
 * so the vocabulary now has two consumers that must not bundle Drizzle to name it, and a literal on
 * the database side would have been a second copy free to drift from both.
 *
 * The order is the order the column was created with, and it is load-bearing for that reason alone:
 * a `pgEnum` generated from a reordered tuple is a migration, not an edit.
 */
export const VALIDATION_OUTCOMES = ['passed', 'failed'] as const

export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number]

export const isValidationOutcome = createEnumGuard(VALIDATION_OUTCOMES)
