/* cspell:words netrc apikey */
/**
 * **What the setup bundle installed, in the shape the redactor takes (T239, T231, FR-045, FR-072,
 * FR-089).**
 *
 * `secret-registry.ts` gave the run a set of known values that can grow after the sanitisers were
 * built, and `credential-install.ts` and `credential/rotation-watch.ts` grow it with the **agent's**
 * login. Nothing grew it with the **client's** credentials, which is the half FR-072 is actually
 * about: the material a customer's own `setup.sh` puts on the instance in bootstrap phase 5. Until
 * something does, the only thing standing between a client's repository-host token and the log the
 * panel streams is `secret-patterns.ts` — pattern matching, which by construction only catches
 * formats somebody anticipated, and a client-supplied bundle is precisely the case where nobody did.
 *
 * This module is the reading half of closing that. It takes the **text of a file the bundle wrote**
 * and returns the values in it worth treating as secrets. `run/bootstrap.ts` does the file system
 * work and the registration; the parsing is here because it is a pure function over a string and
 * because it is the part with the interesting judgement in it.
 *
 * ## Why it guesses at all
 *
 * `contracts/setup-bundle.md` gives the bundle `credentials/` and says only "whatever setup.sh
 * needs". That freedom is deliberate — `run/forge-credential.ts` argues at length why inventing a
 * file name would be a contract change dressed up as an implementation detail — and every bundle
 * already in a client's hands was authored against it. So there is no schema to read, and the
 * choice is between guessing at the values or knowing none of them. A guess that occasionally
 * registers a non-secret is an over-redacted log line; knowing none of them is the leak T231 was
 * filed about.
 *
 * That is the same trade `secret-patterns.ts` states for itself, and the direction is the same one:
 * over-matching is the intended failure.
 *
 * ## What it extracts, and why each rule is here
 *
 * - **A bare line.** A file whose whole content is the token — the commonest shape there is.
 * - **The right-hand side of `key=value` / `key: value`**, plus that value's last whitespace-
 *   separated field, which is what turns an `Authorization: Bearer …` line into the token rather
 *   than into the word `Bearer` followed by it.
 * - **The field after a credential-ish keyword**, which is `.netrc` — `machine … login … password
 *   …` — and any other whitespace-delimited format that names its fields.
 * - **JSON string values**, excluding keys, unescaped so that what is registered is the value as it
 *   exists rather than as it was written. `secret-encodings.ts` regenerates the escaped form.
 * - **The password out of a URL's userinfo**, because a rewritten remote is one of the forms a
 *   bundle is most likely to choose and the credential in it is not on either side of a separator.
 *
 * ## What it refuses to register, which is the part that keeps the log readable
 *
 * Everything in {@link isStructural}: hostnames and URLs, absolute paths, bracketed section
 * headers, punctuation runs and single all-lowercase words. Those are the tokens a credential file
 * is *made of* rather than the ones it carries, and registering them would replace every mention of
 * `github.com` — or of the word `password` — in the run's log with a placeholder. The one real cost
 * is an all-lowercase-alphabetic credential, which is not registered here and falls back to pattern
 * matching; a credential of that shape is rare and the alternative is a log that redacts English.
 */

import { MIN_SECRET_LENGTH } from './secret-encodings'
import type { KnownSecret } from './secret-values'

/** Prefixes every placeholder this path produces: `[redacted:bundle.forge-token]`. */
export const BUNDLE_SECRET_NAME_PREFIX = 'bundle'

/**
 * How many values one file may contribute.
 *
 * A bound rather than a judgement about content: every registered value is expanded into every
 * encoding `secret-encodings.ts` can derive and then matched against every chunk of output, so a
 * file that somehow yields thousands of candidates would make redaction the most expensive thing in
 * the output path. A credential file with more than this many distinct values in it is not a
 * credential file.
 */
export const MAX_BUNDLE_VALUES_PER_FILE = 64

/** Lines longer than this are not read as text; see {@link bundleCredentialValues}. */
export const MAX_CREDENTIAL_LINE_LENGTH = 8192

/**
 * A non-secret label for a value, derived from where it was found.
 *
 * The path is the bundle author's own file name, which is not secret — names come from the bundle
 * and lengths are what must not survive (`secret-values.ts`). Non-conforming characters are folded
 * so the result satisfies that module's `SAFE_NAME` and reaches the placeholder verbatim: a name
 * that failed it would degrade to the neutral `credential` label and an operator would lose the one
 * piece of information the placeholder exists to carry.
 *
 * @param relativePath - Where the file sits beneath the credential directory.
 */
export const bundleSecretName = (relativePath: string): string => {
  const safe = relativePath.replace(/[^A-Za-z0-9._-]+/gu, '.').replace(/^\.+|\.+$/gu, '')

  return safe === '' ? BUNDLE_SECRET_NAME_PREFIX : `${BUNDLE_SECRET_NAME_PREFIX}.${safe}`
}

/** Field names that introduce a credential in a whitespace-delimited format. */
const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'key',
  'login',
  'passwd',
  'password',
  'secret',
  'token',
])

/**
 * `key=value` and `key: value`, split at the **first** separator.
 *
 * The key half may hold whitespace — `export FORGE_TOKEN=…` and an indented `\thelper = store` are
 * both lines a bundle writes — while the value half may not be split again, because a credential
 * can contain a colon and a key never does.
 */
const KEY_VALUE = /^[^:=]{1,120}[:=]\s*(.+)$/u

/** Every quoted string on a line, in order. Which of them are keys is decided by what follows. */
const JSON_STRING = /"((?:[^"\\]|\\.)*)"/gu

/** `scheme://userinfo@host`, from which only the password half is wanted. */
const URL_USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/@]+)@/u

/**
 * Shapes that appear in credential files without being credentials.
 *
 * Each one is a value that would otherwise be registered and would then be removed from every log
 * line that mentioned it. A hostname is the worst of them — `github.com` appears in almost every
 * line a delivery step writes — and an all-lowercase word is the one that would remove the word
 * `password` from the run's own explanations of what it redacted.
 */
const isStructural = (value: string): boolean =>
  // A host, or a URL with no credential in it.
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d+)?(?:\/\S*)?$/u.test(
    value,
  ) ||
  // An absolute path: a helper's location, not its output.
  value.startsWith('/') ||
  // An ini or git-config section header.
  /^\[[^\]]*\]$/u.test(value) ||
  // A single all-lowercase word: the field names the formats above are built from.
  /^[a-z]+$/u.test(value) ||
  // A rule, a comment bar, a run of padding.
  !/[A-Za-z0-9]/u.test(value)

/** Quotes and trailing structure a value picks up from the format it was written in. */
const unwrap = (value: string): string => {
  const trimmed = value.trim().replace(/[,;]+$/u, '')
  const quoted = /^(["'])(.*)\1$/u.exec(trimmed)

  return (quoted?.[2] ?? trimmed).trim()
}

const isPlausibleSecret = (value: string): boolean =>
  value.length >= MIN_SECRET_LENGTH &&
  // Whitespace and control characters: a credential contains neither, and a candidate that does
  // is a fragment of the format rather than a value out of it.
  !/[\s\p{Cc}]/u.test(value) &&
  !isStructural(value)

const addCandidate = (into: Set<string>, raw: string): void => {
  const value = unwrap(raw)

  if (isPlausibleSecret(value)) {
    into.add(value)
  }

  // A rewritten remote carries its credential in the userinfo, where no separator rule reaches it.
  const userinfo = URL_USERINFO.exec(value)?.[1]
  const password = userinfo === undefined ? undefined : userinfo.slice(userinfo.indexOf(':') + 1)

  if (userinfo !== undefined && userinfo.includes(':') && password !== undefined) {
    const decoded = ((): string => {
      try {
        return decodeURIComponent(password)
      } catch {
        return password
      }
    })()

    if (isPlausibleSecret(password)) {
      into.add(password)
    }

    if (decoded !== password && isPlausibleSecret(decoded)) {
      into.add(decoded)
    }
  }
}

/**
 * Every quoted string on the line that is not a key.
 *
 * Left to right, consuming each string as it goes, and the key test is made on what **follows** the
 * closing quote. A lookahead written into {@link JSON_STRING} itself would not do this: rejecting a
 * key lets the scan restart from that key's closing quote, and the separator between it and its
 * value then reads as a string of its own — matching `": ` and consuming the value's opening quote
 * with it, so the one string that mattered is never offered.
 */
const addJsonStrings = (into: Set<string>, line: string): void => {
  for (const match of line.matchAll(JSON_STRING)) {
    const raw = match[1]
    const after = line.slice(match.index + match[0].length)

    if (raw === '' || /^\s*:/u.test(after)) {
      continue
    }

    // Unescaped, so what is registered is the value as it exists rather than as it was written;
    // `secret-encodings.ts` derives the written form back from it.
    const value = ((): string => {
      try {
        return JSON.parse(`"${raw}"`) as string
      } catch {
        return raw
      }
    })()

    addCandidate(into, value)
  }
}

const addFieldValues = (into: Set<string>, line: string): void => {
  const fields = line.split(/\s+/u).filter((field) => field !== '')

  for (const [index, field] of fields.entries()) {
    if (CREDENTIAL_FIELD_NAMES.has(field.toLowerCase().replace(/[:=]+$/u, ''))) {
      const next = fields.at(index + 1)

      if (next !== undefined) {
        addCandidate(into, next)
      }
    }
  }
}

/**
 * The values in one credential file worth removing from this run's output.
 *
 * @param text - The file's contents, as the bundle wrote them.
 * @returns Distinct candidate values, in the order they were found, bounded by
 *   {@link MAX_BUNDLE_VALUES_PER_FILE}.
 */
export const bundleCredentialValues = (text: string): readonly string[] => {
  const found = new Set<string>()

  for (const raw of text.split('\n')) {
    if (found.size >= MAX_BUNDLE_VALUES_PER_FILE) {
      break
    }

    const line = raw.replace(/\r$/u, '').trim()

    // A minified JSON document is one enormous line and is still worth reading; a line longer than
    // this is a key file, a blob or a base64 archive, and none of those has fields to find.
    if (line === '' || line.startsWith('#') || line.length > MAX_CREDENTIAL_LINE_LENGTH) {
      continue
    }

    addJsonStrings(found, line)
    addFieldValues(found, line)

    const assigned = KEY_VALUE.exec(line)?.[1]?.trim()

    // The line itself, when it is not an assignment — the file that holds nothing but a token — or
    // when it is a rewritten remote, whose credential sits in the userinfo rather than after a
    // separator and which `KEY_VALUE` would otherwise read as the scheme's value.
    if (assigned === undefined || URL_USERINFO.test(line)) {
      addCandidate(found, line)
    }

    if (assigned === undefined) {
      continue
    }

    addCandidate(found, assigned)

    // `Authorization: Bearer …`, and every other value whose scheme is not the secret.
    const last = assigned.split(/\s+/u).at(-1)

    if (last !== undefined && last !== assigned) {
      addCandidate(found, last)
    }
  }

  return [...found].slice(0, MAX_BUNDLE_VALUES_PER_FILE)
}

/**
 * One credential file, as a list of registry entries.
 *
 * @param input - Where the file sits beneath the credential directory, and its contents.
 * @returns One {@link KnownSecret} per value, all named after the file.
 */
export const bundleCredentialSecrets = (input: {
  readonly relativePath: string
  readonly text: string
}): readonly KnownSecret[] => {
  const name = bundleSecretName(input.relativePath)

  return bundleCredentialValues(input.text).map((value) => ({ name, value }))
}
