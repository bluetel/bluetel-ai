/**
 * The sanitisation seam (T060, FR-045, FR-046, FR-072).
 *
 * `SanitisedText` is a branded string with exactly one construction site: the
 * sanitiser below. Everything that persists or transmits output — the S3 store
 * and the machine-surface reporter in `segments.ts` — accepts only this type,
 * so "sanitise before writing" is not a convention anyone has to remember. A
 * raw `string` will not type-check at either boundary, which makes the
 * unsanitised-copy-at-rest failure a compile error rather than a code review.
 *
 * The order is strip → redact, and it is not interchangeable. Redacting first
 * would let a colour sequence sitting in the middle of a token hide it from
 * both stages: the pattern would not match across the escape bytes, and the
 * known-value comparison would fail on a value it has never seen written that
 * way.
 */

import { createStreamingRedactor } from './redact'
import type { KnownSecret } from './secret-values'
import { createControlStripper } from './strip-control'

declare const sanitisedTextBrand: unique symbol

/**
 * Output that has been through the whole pipeline. Only `createSanitiser` can
 * produce a value of this type.
 */
export type SanitisedText = string & { readonly [sanitisedTextBrand]: 'output-sanitised' }

export const EMPTY_SANITISED_TEXT = '' as SanitisedText

/** Byte length of sanitised text, which is what a segment's size means. */
export const sanitisedByteLength = (text: SanitisedText): number =>
  new TextEncoder().encode(text).length

export interface SanitiserOptions {
  /** Every credential the setup bundle installed (FR-072). */
  readonly secrets?: readonly KnownSecret[]
  /** Passed through to the control stripper's retention window. */
  readonly retainRows?: number
}

export interface Sanitiser {
  /** Feed raw output; returns the part that is complete and safe to release. */
  readonly push: (chunk: string) => SanitisedText
  /** Release everything held back by either stage. */
  readonly flush: () => SanitisedText
}

export const createSanitiser = (options: SanitiserOptions = {}): Sanitiser => {
  const stripper = createControlStripper(
    options.retainRows === undefined ? {} : { retainRows: options.retainRows },
  )
  const redactor = createStreamingRedactor(
    options.secrets === undefined ? {} : { secrets: options.secrets },
  )

  return {
    push: (chunk: string): SanitisedText => redactor.push(stripper.push(chunk)) as SanitisedText,
    flush: (): SanitisedText =>
      (redactor.push(stripper.flush()) + redactor.flush()) as SanitisedText,
  }
}

/** Sanitise a complete string in one pass. */
export const sanitise = (input: string, options: SanitiserOptions = {}): SanitisedText => {
  const sanitiser = createSanitiser(options)

  return (sanitiser.push(input) + sanitiser.flush()) as SanitisedText
}
