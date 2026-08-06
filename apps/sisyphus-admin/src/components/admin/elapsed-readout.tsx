'use client'

import { useEffect, useState } from 'react'

import { elapsedReadout } from './format-elapsed'

/** How often the readout advances. One second, because it is displayed to the second. */
const TICK_MS = 1000

interface ElapsedReadoutProps {
  /** Present participle of the action, sentence case: `Deactivating`, `Revoking`, `Issuing`. */
  verb: string
  /** `Date.now()` at the moment the action started. */
  startedAt: number
}

/**
 * The live readout an in-flight button shows in place of its label (FR-029).
 *
 * It is a component rather than a hook so it can be rendered and asserted without a testing
 * library, and so the interval belongs to the readout rather than to whichever button is hosting
 * it — a button that unmounts on success takes the timer with it.
 *
 * The first frame is `verb 0:00`, which is also what a server render produces, so nothing shifts
 * when the client takes over.
 *
 * It sets no type token. The readout lives inside a button, and a button's label is sentence-case
 * Archivo — uppercase mono is for labels, metadata and state, not for a thing a person is doing.
 * All it asks for is tabular figures, so the seconds column does not jitter as the clock advances.
 */
export const ElapsedReadout = ({ verb, startedAt }: ElapsedReadoutProps) => {
  const [now, setNow] = useState(startedAt)

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)

    return () => {
      clearInterval(timer)
    }
  }, [startedAt])

  return <span className="tabular-nums">{elapsedReadout(verb, now - startedAt)}</span>
}
