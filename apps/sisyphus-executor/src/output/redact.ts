/**
 * Two-stage redaction (T059, FR-045, FR-072).
 *
 * Stage two of the output pipeline, between control stripping and
 * segmentation. Two stages because neither alone is enough:
 *
 * 1. **Known values.** Every credential the setup bundle installed, removed
 *    verbatim and in every encoding derivable from the value alone. This is
 *    what catches a client credential in a format nobody anticipated.
 * 2. **Patterns.** The credential formats that can be described in advance,
 *    which is the only way to catch a credential the executor was never given
 *    — one the agent minted or read out of a repository mid-run.
 *
 * Known values run first so a credential is labelled by the bundle's name for
 * it rather than by whichever pattern happens to also match.
 *
 * The streaming form exists for one reason: a secret that straddles a chunk
 * boundary. A redactor that processes each read independently sees two halves,
 * matches neither, and emits the credential in two pieces. This one holds back
 * the longest matchable form minus one character until more input arrives, so
 * no boundary can fall inside a match that has not yet been redacted.
 */

import { createKeyBlockFilter, stripPrivateKeyBlocks } from './key-blocks'
import { redactPatterns } from './secret-patterns'
import type { KnownSecret } from './secret-values'
import { buildSecretIndex } from './secret-values'

export interface RedactorOptions {
  /** Every credential the bundle installed (FR-072). */
  readonly secrets?: readonly KnownSecret[]
}

export interface Redactor {
  readonly redact: (text: string) => string
}

export interface StreamingRedactor {
  /** Returns the portion of the stream that is safe to release. */
  readonly push: (chunk: string) => string
  /** Releases everything held back. */
  readonly flush: () => string
}

/**
 * Upper bound on how much a streaming redactor will hold waiting for a line to
 * finish. Past it the hold-back is purely the known-value window, which is
 * still enough to make a split match impossible.
 */
const MAX_LINE_HOLD = 64 * 1024

export const createRedactor = (options: RedactorOptions = {}): Redactor => {
  const index = buildSecretIndex(options.secrets ?? [])

  return {
    redact: (text: string): string => redactPatterns(index.redact(stripPrivateKeyBlocks(text))),
  }
}

export const createStreamingRedactor = (options: RedactorOptions = {}): StreamingRedactor => {
  const index = buildSecretIndex(options.secrets ?? [])
  const keyBlocks = createKeyBlockFilter()
  const holdBack = Math.max(index.longestMatchLength - 1, 0)
  let pending = ''

  /**
   * How much of `pending` must stay held. Whole lines are preferred because
   * most patterns are line-scoped, but the known-value window is the part that
   * is load-bearing: it is what makes a boundary-split secret impossible.
   */
  const heldLength = (): number => {
    const afterLastLine = pending.length - (pending.lastIndexOf('\n') + 1)
    const lineHold = Math.min(afterLastLine, MAX_LINE_HOLD)

    return Math.min(Math.max(lineHold, holdBack), pending.length)
  }

  const release = (upTo: number): string => {
    const releasable = pending.slice(0, upTo)

    pending = pending.slice(upTo)

    return redactPatterns(index.redact(releasable))
  }

  return {
    push: (chunk: string): string => {
      pending += keyBlocks.push(chunk)

      return release(pending.length - heldLength())
    },

    flush: (): string => {
      pending += keyBlocks.flush()

      return release(pending.length)
    },
  }
}
