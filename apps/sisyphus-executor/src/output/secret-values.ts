/**
 * Known-value redaction (T059, FR-045, FR-072).
 *
 * The half of the two-stage redactor that earns its place. Pattern matching
 * catches credentials in formats that were anticipated; a client's credential
 * is very often in a format that was not. So every value the setup bundle
 * installed is removed verbatim wherever it appears, in any of the encodings
 * `secret-encodings.ts` can derive.
 *
 * The placeholder carries the credential's **name**, never its shape. Names
 * come from the bundle manifest and are not secret; lengths are. A
 * length-preserving mask would tell a reader that the token was eight
 * characters long, which for a short secret is most of the work of guessing
 * it — so redaction here is not reversible by inspecting the output.
 */

import { MIN_SECRET_LENGTH, secretEncodings } from './secret-encodings'

export interface KnownSecret {
  /**
   * A non-secret label for the credential — the bundle's name for it. It
   * appears in the placeholder so an operator can tell which credential was
   * removed without learning anything about its value.
   */
  readonly name: string
  readonly value: string
}

/**
 * Where an index gets its values from: a fixed list, or something that can be
 * asked again (003/T054, 003/FR-014).
 *
 * The fixed list was the whole story while every known value was installed by
 * the setup bundle before the first byte of output existed. The agent's own
 * credential is not like that: it is installed in bootstrap phase
 * `credential_install`, and it is **rotated by the agent mid-run**, at a moment
 * nobody chose, long after every sanitiser in the process was constructed. A
 * redactor whose values were frozen at construction would therefore know the
 * material the run started with and not the material it is actually using — and
 * the one it does not know is the one a rotation could echo into a log.
 *
 * So the source may be a function. It is re-read on every use and the index is
 * rebuilt only when the array it answers with is a different array, which is why
 * {@link createSecretRegistry} hands back a stable reference until something is
 * added: expanding a value into every encoding is not free, and doing it per
 * chunk would make redaction the most expensive thing in the output path.
 */
export type SecretSource = readonly KnownSecret[] | (() => readonly KnownSecret[])

export interface SecretIndex {
  readonly redact: (text: string) => string
  /**
   * Length of the longest form the index can match. A streaming caller must
   * hold back this much minus one character, or a secret split across a chunk
   * boundary is emitted in two halves that individually match nothing.
   *
   * A getter rather than a value, because a source that gains a secret gains a
   * longer form with it. A caller that read this once and cached it would hold
   * back too little for the value added after it read.
   */
  readonly longestMatchLength: number
  readonly isEmpty: boolean
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

const placeholderFor = (name: string): string =>
  `[redacted:${SAFE_NAME.test(name) ? name : 'credential'}]`

interface IndexedForm {
  readonly form: string
  readonly placeholder: string
}

/** The expanded forms of one snapshot of a source, longest first. */
const expand = (secrets: readonly KnownSecret[]): readonly IndexedForm[] => {
  const forms: IndexedForm[] = []

  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_LENGTH) {
      continue
    }

    const placeholder = placeholderFor(secret.name)

    for (const form of secretEncodings(secret.value)) {
      forms.push({ form, placeholder })
    }
  }

  forms.sort((left, right) => right.form.length - left.form.length)

  return forms
}

/**
 * Build a redactor over the values this run knows about.
 *
 * Forms are applied longest-first so a value that is a prefix of another does
 * not shadow it, and so a base64 fragment is not partially consumed by a
 * shorter overlapping form.
 *
 * A `SecretSource` that is an array behaves exactly as it always did: the array
 * reference never changes, so the expansion happens once, on the first use. A
 * source that is a function is re-read on every use and re-expanded only when it
 * answers with a different array — see {@link SecretSource} for why anything is
 * allowed to change after construction at all.
 */
export const buildSecretIndex = (source: SecretSource): SecretIndex => {
  let expandedFrom: readonly KnownSecret[] | undefined
  let forms: readonly IndexedForm[] = []

  const current = (): readonly IndexedForm[] => {
    const secrets = typeof source === 'function' ? source() : source

    if (secrets !== expandedFrom) {
      expandedFrom = secrets
      forms = expand(secrets)
    }

    return forms
  }

  return {
    redact: (text: string): string => {
      let output = text

      for (const { form, placeholder } of current()) {
        if (output.includes(form)) {
          output = output.split(form).join(placeholder)
        }
      }

      return output
    },
    get longestMatchLength() {
      const indexed = current()

      return indexed.length === 0 ? 0 : (indexed[0]?.form.length ?? 0)
    },
    get isEmpty() {
      return current().length === 0
    },
  }
}
