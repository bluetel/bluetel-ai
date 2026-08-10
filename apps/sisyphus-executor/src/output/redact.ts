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
import type { SecretSource } from './secret-values'
import { buildSecretIndex } from './secret-values'

export interface RedactorOptions {
  /**
   * Every value this run knows: the credentials the bundle installed (FR-072),
   * and — when the caller passes a re-readable source — the agent's own
   * credential as it stands after any mid-run rotation (003/FR-014). See
   * {@link SecretSource}.
   */
  readonly secrets?: SecretSource
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
  let pending = ''

  /**
   * How much of `pending` must stay held. Whole lines are preferred because
   * most patterns are line-scoped, but the known-value window is the part that
   * is load-bearing: it is what makes a boundary-split secret impossible.
   *
   * The window is read from the index on every call rather than cached at
   * construction. A run that learns a longer value part-way through — a rotated
   * agent credential (003/FR-014) — needs the hold-back to grow with it, and a
   * value cached here would hold back the window of the values known before the
   * one that matters arrived.
   */
  const heldLength = (): number => {
    const holdBack = Math.max(index.longestMatchLength - 1, 0)
    const afterLastLine = pending.length - (pending.lastIndexOf('\n') + 1)
    const lineHold = Math.min(afterLastLine, MAX_LINE_HOLD)

    return Math.min(Math.max(lineHold, holdBack), pending.length)
  }

  /**
   * Remove known values from the **whole** buffer, then release what is settled.
   *
   * The order matters and it is the one thing here that is not obvious. Redacting
   * only the slice about to be released would leave the release boundary free to
   * fall *inside* a value that is wholly present in the buffer: the head would go
   * out unredacted and the tail would be held, and neither half would ever match
   * anything again. The hold-back does not prevent that on its own — it bounds
   * how much is kept, not where the cut lands — and the case is reachable as soon
   * as the buffer grows past the hold-back window, which is every busy run.
   *
   * Redacting first makes the question moot: every complete occurrence in the
   * buffer is already a placeholder, so the only thing a cut can now split is a
   * value the rest of the stream has not finished delivering — and the hold-back
   * is exactly the window that keeps such a head in the buffer until it has.
   *
   * Re-redacting the held tail on the next push costs a scan of at most the
   * hold-back window and is idempotent: a placeholder contains no value's
   * encoding, so nothing matches twice.
   */
  const release = (settle: boolean): string => {
    pending = index.redact(pending)

    const upTo = settle ? pending.length : pending.length - heldLength()
    const releasable = pending.slice(0, upTo)

    pending = pending.slice(upTo)

    return redactPatterns(releasable)
  }

  return {
    push: (chunk: string): string => {
      pending += keyBlocks.push(chunk)

      return release(false)
    },

    flush: (): string => {
      pending += keyBlocks.flush()

      return release(true)
    },
  }
}
