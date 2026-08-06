/**
 * Latency summarisation for spike S3.
 *
 * SC-002 is a *visibility* target — "≥95% of segments visible within 5 seconds" — so the
 * denominator is the number of segments **produced**, not the number received. A transport that
 * drops half the stream and delivers the rest in 3ms would otherwise score 100%, which is exactly
 * the silent failure this spike exists to catch.
 */

/** SC-002's budget: a segment is "visible" only if it arrives inside this window. */
export const VISIBILITY_BUDGET_MS = 5_000

export interface LatencySummary {
  /** How many segments the producer wrote. The denominator for {@link fractionWithinBudget}. */
  readonly producedCount: number
  /** How many of those the consumer actually observed. */
  readonly sampleCount: number
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly p99Ms: number | null
  readonly maxMs: number | null
  /** Observed within {@link VISIBILITY_BUDGET_MS}, over `producedCount`. */
  readonly fractionWithinBudget: number
  /** SC-002's pass mark. */
  readonly meetsSc002: boolean
}

/**
 * Nearest-rank percentile over an already-sorted ascending array.
 *
 * Nearest-rank rather than interpolated: with a few hundred samples an interpolated p95 invents a
 * value that no segment actually experienced, and this spike reports observations.
 */
export const percentile = (sortedAscending: readonly number[], fraction: number): number | null => {
  if (sortedAscending.length === 0) return null
  const rank = Math.ceil(fraction * sortedAscending.length)
  const index = Math.min(Math.max(rank, 1), sortedAscending.length) - 1
  return sortedAscending[index] ?? null
}

export const summariseLatencies = (
  samplesMs: readonly number[],
  producedCount: number,
): LatencySummary => {
  const sorted = [...samplesMs].sort((left, right) => left - right)
  const withinBudget = sorted.filter((value) => value < VISIBILITY_BUDGET_MS).length
  const fractionWithinBudget = producedCount === 0 ? 0 : withinBudget / producedCount
  return {
    producedCount,
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
    fractionWithinBudget,
    meetsSc002: fractionWithinBudget >= 0.95,
  }
}

/** One line per transport, so the findings table is generated rather than transcribed. */
export const formatLatencySummary = (label: string, summary: LatencySummary): string => {
  const format = (value: number | null): string => (value === null ? 'n/a' : `${value}ms`)
  const percent = (summary.fractionWithinBudget * 100).toFixed(1)
  return [
    label,
    `n=${summary.sampleCount}/${summary.producedCount}`,
    `p50=${format(summary.p50Ms)}`,
    `p95=${format(summary.p95Ms)}`,
    `p99=${format(summary.p99Ms)}`,
    `max=${format(summary.maxMs)}`,
    `<5s=${percent}%`,
    summary.meetsSc002 ? 'SC-002 PASS' : 'SC-002 FAIL',
  ].join('  ')
}
