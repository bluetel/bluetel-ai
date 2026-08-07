/* cspell:words ratelimit */
/**
 * What went wrong when the code host was asked something (T195).
 *
 * ## Why the kind is a field and not a sentence
 *
 * `./pull-request.ts` turns `branchHead` returning `undefined` into "the push
 * never happened, no pull request was opened". That is a **correct** and
 * actionable report when the host really has no such branch, and a dangerous
 * lie when the request merely failed — an expired credential, a 502 from a
 * proxy, or a DNS blip would all be reported to the engineer as "your work
 * never left the instance", which is the one thing pushed-commit verification
 * exists to be trustworthy about.
 *
 * So `not_found` is a kind, not an absence, and it is the **only** kind
 * `./forge-http.ts` is allowed to convert into `undefined`. Every other
 * failure is a thrown {@link ForgeError} carrying a kind the caller can
 * distinguish:
 *
 * | Kind           | What it means                            | Retried |
 * | -------------- | ---------------------------------------- | ------- |
 * | `not_found`    | The host answered: no such thing         | no      |
 * | `unauthorised` | The credential is wrong or lacks a scope | no      |
 * | `rate_limited` | The host asked us to slow down           | yes     |
 * | `conflict`     | The host refused the state change        | no      |
 * | `invalid`      | The request was malformed                | no      |
 * | `transient`    | 5xx, a timeout, or the socket died       | yes     |
 *
 * Retrying an `unauthorised` is a way to turn one wrong token into three
 * failed authentications, and retrying a `conflict` is how a duplicate gets
 * opened, so neither is retryable however tempting the loop looks.
 *
 * ## The credential is never in here
 *
 * Nothing in this module reads a credential and nothing holds one. What it
 * does take is a `redact` function, and every scrap of host-supplied text
 * passes through it before it reaches a message — because a host that echoes
 * the `Authorization` header back in an error body is entirely ordinary, and
 * an error message is exactly the thing that ends up in a run record and on
 * the panel (FR-072). `./forge-http.ts` builds that function from the
 * executor's own known-value redactor, so the credential is removed verbatim
 * and in every encoding derivable from it, not merely where a pattern happens
 * to match.
 */

export type ForgeErrorKind =
  | 'not_found'
  | 'unauthorised'
  | 'rate_limited'
  | 'conflict'
  | 'invalid'
  | 'transient'

/**
 * The kinds a retry can plausibly fix.
 *
 * Both are "ask again later" answers. Everything else is a statement about the
 * request itself, and asking again changes nothing but the log.
 */
export const RETRYABLE_FORGE_ERROR_KINDS: readonly ForgeErrorKind[] = ['rate_limited', 'transient']

/** Long enough to be diagnostic, short enough not to paste a response body into a record. */
export const MAX_FORGE_DETAIL_LENGTH = 300

export interface ForgeErrorOptions {
  readonly kind: ForgeErrorKind
  /** What was being attempted, in the caller's words. Never a URL. */
  readonly operation: string
  readonly status?: number
  /** How long the host asked us to wait, where it said so. */
  readonly retryAfterMs?: number
  /** Already redacted and already bounded by the caller. */
  readonly detail?: string
  readonly cause?: unknown
}

const describe = (options: ForgeErrorOptions): string => {
  const status =
    options.status === undefined ? `(${options.kind})` : `HTTP ${options.status} (${options.kind})`
  const detail = options.detail === undefined || options.detail === '' ? '' : ` ${options.detail}`

  return `${options.operation} failed: ${status}.${detail}`
}

/**
 * A failure the code host is responsible for, classified.
 *
 * The URL is deliberately absent from the message. It names the repository and
 * the branch, which are already in `operation` where the caller chose to put
 * them, and a URL is the one field a credential has historically been smuggled
 * out in.
 */
export class ForgeError extends Error {
  readonly kind: ForgeErrorKind
  readonly operation: string
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined

  constructor(options: ForgeErrorOptions) {
    super(describe(options), options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'ForgeError'
    this.kind = options.kind
    this.operation = options.operation
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
  }
}

/** Whether asking again could plausibly produce a different answer. */
export const isRetryableForgeError = (error: unknown): error is ForgeError =>
  error instanceof ForgeError && RETRYABLE_FORGE_ERROR_KINDS.includes(error.kind)

/** Whether the host answered "no such thing" — the only failure that becomes `undefined`. */
export const isNotFoundForgeError = (error: unknown): error is ForgeError =>
  error instanceof ForgeError && error.kind === 'not_found'

const RETRY_AFTER_HEADER = 'retry-after'
const RATE_LIMIT_RESET_HEADER = 'x-ratelimit-reset'
const RATE_LIMIT_REMAINING_HEADER = 'x-ratelimit-remaining'

const MILLISECONDS = 1000

const seconds = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined
  }

  const parsed = Number(value.trim())

  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * How long the host asked us to wait, in milliseconds, or `undefined` if it did
 * not say.
 *
 * `Retry-After` in its delta-seconds form is preferred because it is a
 * duration and needs no clock agreement. `X-RateLimit-Reset` is an absolute
 * epoch second, so it is only usable relative to our own clock — which is why
 * it is second and why a reset already in the past reads as zero rather than
 * as a negative wait.
 *
 * The HTTP-date form of `Retry-After` is not parsed: it is not what a code host
 * sends for a rate limit, and a half-supported date parser is worse than an
 * absent one because it fails by producing a plausible number.
 *
 * @param headers - The response headers, as received.
 * @param nowMs - Current epoch milliseconds; injected so the reset form is testable.
 * @returns The wait in milliseconds, or `undefined`.
 */
export const retryAfterMsFrom = (headers: Headers, nowMs: number): number | undefined => {
  const delta = seconds(headers.get(RETRY_AFTER_HEADER))

  if (delta !== undefined) {
    return Math.max(0, delta * MILLISECONDS)
  }

  const reset = seconds(headers.get(RATE_LIMIT_RESET_HEADER))

  if (reset !== undefined) {
    return Math.max(0, reset * MILLISECONDS - nowMs)
  }

  return undefined
}

/**
 * Whether a `403` is the host throttling us rather than refusing us.
 *
 * Hosts overload `403` for both, and the two want opposite handling: a
 * throttle should be waited out, a refusal should stop the run and tell
 * somebody the token is wrong. The exhausted budget is the discriminator —
 * a permissions `403` carries a remaining count that is not zero, or none at
 * all — with a secondary-limit `Retry-After` as the other tell.
 */
const isThrottled = (headers: Headers): boolean =>
  headers.get(RATE_LIMIT_REMAINING_HEADER)?.trim() === '0' ||
  headers.get(RETRY_AFTER_HEADER) !== null

/**
 * Classify a status the host returned.
 *
 * @param status - The HTTP status.
 * @param headers - The response headers, which is where a throttled `403` is told from a refused one.
 * @returns The kind the caller branches on.
 */
export const forgeErrorKindForStatus = (status: number, headers: Headers): ForgeErrorKind => {
  if (status === 401) {
    return 'unauthorised'
  }

  if (status === 403) {
    return isThrottled(headers) ? 'rate_limited' : 'unauthorised'
  }

  if (status === 404) {
    return 'not_found'
  }

  if (status === 408) {
    return 'transient'
  }

  // 409 and 422 are both "the host understood and refused the state change".
  // A duplicate pull request arrives as 422, which is why `./forge-http.ts`
  // answers a conflict by looking again rather than by retrying (FR-077).
  if (status === 409 || status === 422) {
    return 'conflict'
  }

  if (status === 429) {
    return 'rate_limited'
  }

  return status >= 500 ? 'transient' : 'invalid'
}

/** Bound and redact host-supplied text before it can reach a message. */
export const forgeDetail = (body: string, redact: (text: string) => string): string => {
  const redacted = redact(body).trim()

  return redacted.length > MAX_FORGE_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_FORGE_DETAIL_LENGTH)}…`
    : redacted
}

export interface HttpForgeFailure {
  readonly operation: string
  readonly status: number
  readonly headers: Headers
  /** The response body as text. Redacted here, never before. */
  readonly body: string
  readonly redact: (text: string) => string
  readonly nowMs: number
}

/**
 * Turn a refused response into a classified error.
 *
 * @param failure - The operation, the response, and how to strip a credential out of it.
 * @returns The error to throw.
 */
export const httpForgeError = (failure: HttpForgeFailure): ForgeError => {
  const kind = forgeErrorKindForStatus(failure.status, failure.headers)
  const retryAfterMs =
    kind === 'rate_limited' ? retryAfterMsFrom(failure.headers, failure.nowMs) : undefined

  return new ForgeError({
    kind,
    operation: failure.operation,
    status: failure.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    detail: forgeDetail(failure.body, failure.redact),
  })
}

/**
 * A request that never got an answer — DNS, TLS, a reset socket, an abort.
 *
 * Always `transient`. This is the case that must never be mistaken for
 * `not_found`: the host was not asked, so it has said nothing about whether the
 * branch exists.
 *
 * @param operation - What was being attempted.
 * @param cause - Whatever `fetch` rejected with.
 * @param redact - Applied to the cause's message before it is quoted.
 * @returns The error to throw.
 */
export const transportForgeError = (
  operation: string,
  cause: unknown,
  redact: (text: string) => string,
): ForgeError =>
  new ForgeError({
    kind: 'transient',
    operation,
    detail: forgeDetail(
      cause instanceof Error ? cause.message : 'the request did not complete',
      redact,
    ),
    cause,
  })
