/**
 * The set of known values a run is redacting, as it stands **now** (003/T054,
 * 003/FR-014, 003/SC-014).
 *
 * Everything the setup bundle installs is known before the first byte of output
 * exists, so for 002 a `readonly KnownSecret[]` handed to `createSanitiser` was
 * the whole mechanism. 003 adds a value that does not behave that way. The
 * agent's own credential arrives in bootstrap phase `credential_install`, after
 * the reporting path is already armed, and the agent **rotates it mid-run** —
 * so the material this process must not let reach a log is not the material it
 * was started with.
 *
 * This is the smallest thing that closes that gap: one mutable set, one stable
 * array reference, and no second redaction path. The sanitisers, the streaming
 * redactor and the segment writer are unchanged in every respect except that
 * their `secrets` option now accepts something re-readable — see
 * {@link SecretSource}. A parallel "also redact this" hook would have been the
 * alternative, and it would have meant two lists to keep in step and one of them
 * silently missing from whichever sink was added next.
 *
 * ## Why `current()` must return the same array until something is added
 *
 * `buildSecretIndex` rebuilds when the array it is handed is a different array,
 * and rebuilding expands every value into every encoding `secret-encodings.ts`
 * can derive. A registry that answered with a fresh copy each time would look
 * identical and would re-expand every value on every chunk of agent output,
 * which is the sort of cost that is discovered as a throughput problem months
 * later. So the array is rebuilt on `add` and only on `add`.
 */

import type { KnownSecret } from '@bluetel-ai/sisyphus-redaction'

export interface SecretRegistry {
  /**
   * Add a value to be redacted from here on.
   *
   * Idempotent by name **and** value: re-adding the same pair leaves the array
   * reference alone, so a rotation reported twice — a watcher that fired on a
   * touch which changed no bytes, and then again — does not invalidate the
   * expanded index for nothing.
   *
   * A value already present under a *different* name is still added, because
   * the names are what an operator reads out of a placeholder and suppressing
   * one would mislabel the other.
   */
  readonly add: (secret: KnownSecret) => void
  /**
   * The values known now, as a stable reference. Suitable to pass directly as a
   * {@link SecretSource}, which is the only reason it is a function.
   */
  readonly current: () => readonly KnownSecret[]
}

/**
 * Build a registry, optionally seeded with the values already known.
 *
 * @param initial - Typically the credentials the setup bundle installed, which
 *   are known before this run produces any output at all.
 */
export const createSecretRegistry = (initial: readonly KnownSecret[] = []): SecretRegistry => {
  let secrets: readonly KnownSecret[] = [...initial]

  return {
    add: (secret: KnownSecret): void => {
      const present = secrets.some(
        (known) => known.name === secret.name && known.value === secret.value,
      )

      if (present) {
        return
      }

      secrets = [...secrets, secret]
    },
    current: (): readonly KnownSecret[] => secrets,
  }
}
