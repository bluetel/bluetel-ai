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

export interface SecretIndex {
  readonly redact: (text: string) => string
  /**
   * Length of the longest form the index can match. A streaming caller must
   * hold back this much minus one character, or a secret split across a chunk
   * boundary is emitted in two halves that individually match nothing.
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

/**
 * Build a redactor over the credentials the bundle installed.
 *
 * Forms are applied longest-first so a value that is a prefix of another does
 * not shadow it, and so a base64 fragment is not partially consumed by a
 * shorter overlapping form.
 */
export const buildSecretIndex = (secrets: readonly KnownSecret[]): SecretIndex => {
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

  const longestMatchLength = forms.length === 0 ? 0 : forms[0].form.length

  return {
    redact: (text: string): string => {
      let output = text

      for (const { form, placeholder } of forms) {
        if (output.includes(form)) {
          output = output.split(form).join(placeholder)
        }
      }

      return output
    },
    longestMatchLength,
    isEmpty: forms.length === 0,
  }
}
