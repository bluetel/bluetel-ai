/**
 * The arithmetic behind an in-flight button's readout (FR-029).
 *
 * A button that is working replaces its label with a live readout rather than a spinner — `Saving
 * 0:04`, not an indeterminate ring. A spinner says something is happening, which the operator
 * already knew; the readout says how long it has been happening, which is what they actually
 * wanted to know, and it is the difference between "this is slow" and "this is stuck".
 *
 * Separated from the component so the clock formatting is testable directly, which is the only
 * part of a readout that can be wrong.
 */

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const PADDED_SECONDS_WIDTH = 2

/**
 * Render a duration as `m:ss`, counting up.
 *
 * Minutes are not padded and seconds always are, so the readout reads as a stopwatch rather than
 * as a timestamp. Anything at or below zero — including a clock that went backwards — reads as
 * `0:00` rather than as a negative duration, because a button cannot have been working for less
 * than no time.
 *
 * @param elapsedMs - Milliseconds since the action started.
 */
export const formatElapsed = (elapsedMs: number): string => {
  const total =
    Number.isFinite(elapsedMs) && elapsedMs > 0
      ? Math.floor(elapsedMs / MILLISECONDS_PER_SECOND)
      : 0

  const minutes = Math.floor(total / SECONDS_PER_MINUTE)
  const seconds = total % SECONDS_PER_MINUTE

  return `${String(minutes)}:${String(seconds).padStart(PADDED_SECONDS_WIDTH, '0')}`
}

/**
 * The whole readout: what the button is doing, and for how long.
 *
 * @param verb - Present participle of the action, sentence case — buttons stay sentence-case
 *   Archivo, so `Deactivating`, never `DEACTIVATING`.
 * @param elapsedMs - Milliseconds since the action started.
 */
export const elapsedReadout = (verb: string, elapsedMs: number): string =>
  `${verb} ${formatElapsed(elapsedMs)}`
