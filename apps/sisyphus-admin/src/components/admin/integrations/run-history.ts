import type { IntegrationRunView } from './integrations-client'

/**
 * The tick history, as an admin reads it (T199, FR-105).
 *
 * FR-105 asks for the history to be visible **so a silently-failing connector is detectable**, and
 * that clause is what shapes these rows. A run is not summarised as "ok"; it is summarised as what
 * it examined, matched, started and skipped, because the failure mode the requirement names is a
 * board that keeps answering and stops producing — an integration examining forty tickets and
 * starting none looks identical to a healthy one under any status-only rendering.
 *
 * Kept out of the card because the card cannot be driven by a test in this app, and this is the
 * part that can be wrong.
 */

/** One tick, flattened to what a row displays. */
export interface RunHistoryRow {
  readonly id: string
  /** `scheduled` or `manual` (FR-105). */
  readonly trigger: string
  readonly startedAt: string
  /** How long it took, or that it has not finished. */
  readonly duration: string
  /** The counts, as one line. */
  readonly counts: string
  /** The failure, where there was one (FR-108). */
  readonly error: string | undefined
  /** True when the tick recorded an error, so the row can be marked. */
  readonly failed: boolean
}

const formatTimestamp = (value: Date): string => value.toISOString().replace('T', ' ').slice(0, 19)

/**
 * How long the tick took.
 *
 * A run with no end is "still running" rather than a duration measured against the current clock —
 * the panel is not the thing that knows whether that run is alive, and a number that grows while
 * you watch a crashed tick is worse than no number.
 */
export const formatDuration = (run: IntegrationRunView): string => {
  if (run.endedAt === null) {
    return 'still running'
  }

  const seconds = Math.round((run.endedAt.getTime() - run.startedAt.getTime()) / 1000)

  return seconds < 60
    ? `${String(seconds)}s`
    : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

/**
 * The four counts FR-105 names, always all four.
 *
 * Zeroes are printed rather than omitted: "started 0" is the observation the requirement is about,
 * and a row that dropped its zero counts would render a board that has stopped producing as a board
 * with nothing to report.
 */
export const formatCounts = (run: IntegrationRunView): string =>
  `examined ${String(run.examinedCount)}, matched ${String(run.matchedCount)}, started ${String(run.startedCount)}, skipped ${String(run.skippedCount)}`

export const toRunHistoryRow = (run: IntegrationRunView): RunHistoryRow => ({
  id: run.id,
  trigger: run.trigger,
  startedAt: formatTimestamp(run.startedAt),
  duration: formatDuration(run),
  counts: formatCounts(run),
  error: run.error ?? undefined,
  failed: run.error !== null,
})

export const toRunHistory = (runs: readonly IntegrationRunView[]): readonly RunHistoryRow[] =>
  runs.map(toRunHistoryRow)

/**
 * Whether the recent history looks like a connector failing quietly (FR-105, FR-106).
 *
 * True when every one of the last few ticks matched work and started none of it. That is the shape
 * FR-106's consecutive-failure counter does **not** catch: those ticks succeeded — they reached the
 * board and read it — so nothing auto-disables, and the only signal is the history itself. Stated
 * here so the card can say it rather than leaving an admin to compare columns.
 */
export const looksSilentlyStalled = (runs: readonly IntegrationRunView[]): boolean => {
  const recent = runs.slice(0, 3)

  return (
    recent.length === 3 &&
    recent.every((run) => run.error === null && run.matchedCount > 0 && run.startedCount === 0)
  )
}
