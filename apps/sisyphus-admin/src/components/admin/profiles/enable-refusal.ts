import { describeTrpcError, readTrpcErrorCode } from '@sisyphus-admin/components/admin'
import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

/**
 * Rendering the FR-124 enable gate's refusal (T082, FR-031, FR-124).
 *
 * ## The refusal is a list, and it stays a list
 *
 * `profileCannotBeEnabledError` refuses with one line per failing element:
 *
 * ```
 * This execution profile cannot be enabled yet:
 * - the setup bundle Payments toolchain (version 3) is disabled; enable it before enabling this profile
 * - version 4 of the workspace Payments contains no repositories, so a run launched from this profile
 *   would have nothing to check out
 * ```
 *
 * The gate goes out of its way to collect **every** failure rather than stopping at the first,
 * because an admin fixing three broken repositories should not discover them one enable attempt at
 * a time. Flattening that into "This profile cannot be enabled" in the browser would throw away the
 * only thing that made the check worth performing carefully — and it is exactly the "Something went
 * wrong" DESIGN.md forbids.
 *
 * So each line becomes its own `field-error`: a **machine code** naming the element that failed and
 * a **next action** saying what to do about it, with the server's own sentence kept verbatim beside
 * it as the fact. The server states why it refused; the action states what to do, and those are
 * different sentences.
 *
 * ## Why the element is read from the sentence
 *
 * `ProfileEnableFailure` carries a typed `element`, but a thrown `TRPCError` reaches the browser as
 * a message and a code — the failure list is not on the wire. Matching on the phrasing the gate
 * uses is therefore the only classification available, and it is a *narrowing*: an unmatched line
 * still gets a code, a next action and its own text, so a wording the gate grows tomorrow degrades
 * to a generic entry rather than disappearing.
 */

/** The opening line, which introduces the list rather than naming a failure. */
const PREAMBLE = 'This execution profile cannot be enabled yet:'

/** Which element of the configuration a line is about. Mirrors the gate's own closed set. */
export const ENABLE_FAILURE_ELEMENTS = [
  'profile_version',
  'setup_bundle',
  'workspace_version',
  'unclassified',
] as const

export type EnableFailureElement = (typeof ENABLE_FAILURE_ELEMENTS)[number]

/** One failing element, as the panel renders it. */
export interface EnableFailureNotice {
  readonly element: EnableFailureElement
  /** The gate's own sentence, verbatim. What is wrong. */
  readonly detail: string
  /** A code and a next action. What to do about it. */
  readonly error: FieldErrorContent
}

/** What to do about each kind of failure. Never a restatement of what failed. */
const ACTIONS: Readonly<Record<EnableFailureElement, string>> = {
  profile_version:
    'Publish a version of this profile with a workspace version and a setup bundle version that both still exist, then enable it.',
  setup_bundle:
    'Enable the setup bundle this profile pins, or publish a profile version that pins one that is enabled.',
  workspace_version:
    'Publish a workspace version that contains at least one repository, then point this profile at it.',
  unclassified: 'Fix what the line names, then enable again.',
}

/** `E_PROFILE_ENABLE_SETUP_BUNDLE` — searchable, stable, and quotable in a ticket. */
export const enableFailureCode = (element: EnableFailureElement): string =>
  `E_PROFILE_ENABLE_${element.toUpperCase()}`

/** Which element one line is about, read from the phrasing the gate uses. */
export const classifyEnableFailure = (line: string): EnableFailureElement => {
  if (line.includes('setup bundle')) return 'setup_bundle'
  if (line.includes('no published version') || line.includes('could not be read')) {
    return 'profile_version'
  }
  if (line.includes('workspace')) return 'workspace_version'
  return 'unclassified'
}

/** Strip the list marker the gate writes, leaving the sentence. */
const withoutMarker = (line: string): string => line.replace(/^-\s*/, '').trim()

/**
 * Split a refusal message into one notice per failing element (FR-124).
 *
 * @param message - The gate's multi-line message, exactly as it arrived.
 * @returns One notice per line, in the order the gate reported them. Empty when the message carries
 *   no list, which is the caller's signal to fall back to the ordinary refusal.
 */
export const readEnableFailures = (message: string): readonly EnableFailureNotice[] =>
  message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== PREAMBLE)
    .map(withoutMarker)
    .filter((detail) => detail !== '')
    .map((detail) => {
      const element = classifyEnableFailure(detail)
      return {
        element,
        detail,
        error: { code: enableFailureCode(element), action: ACTIONS[element] },
      }
    })

/** Read the message off whatever the mutation hook handed back. */
const readMessage = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { message } = error as { message?: unknown }
  return typeof message === 'string' ? message : undefined
}

/** What the panel shows after a refused enable: a list where there is one, a single refusal otherwise. */
export interface EnableRefusal {
  /** One entry per failing element (FR-124). Empty for a refusal that named none. */
  readonly failures: readonly EnableFailureNotice[]
  /** The whole-request refusal, always present, so a dead end cannot exist. */
  readonly error: FieldErrorContent
}

/**
 * Describe a refused `setEnabled(true)`.
 *
 * The gate's refusal is a `CONFLICT` carrying the list. Anything else — a vanished profile, a lost
 * session — goes through the shared mapping, because those are not gate failures and pretending
 * they were would put an admin to work on repositories that are fine.
 */
export const describeEnableRefusal = (error: unknown): EnableRefusal => {
  const code = readTrpcErrorCode(error)
  const message = readMessage(error)

  const failures =
    code === 'CONFLICT' && message?.startsWith(PREAMBLE) === true ? readEnableFailures(message) : []

  return {
    failures,
    error:
      failures.length === 0
        ? describeTrpcError(error, {
            CONFLICT: {
              code: 'E_PROFILE_ENABLE_REFUSED',
              action: 'Nothing changed. Read the refusal, fix what it names, and enable again.',
            },
            NOT_FOUND: {
              code: 'E_PROFILE_NOT_FOUND',
              action: 'Reload the list — the profile you were changing is no longer there.',
            },
          })
        : {
            code: 'E_PROFILE_ENABLE_REFUSED',
            action: `Nothing changed. ${String(failures.length)} ${failures.length === 1 ? 'element is' : 'elements are'} listed below; fix each one and enable again.`,
          },
  }
}
