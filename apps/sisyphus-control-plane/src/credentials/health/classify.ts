import type { AgentCredential } from '@bluetel-ai/sisyphus-api/db'

/**
 * Telling a provider limit from a broken login — research R5, and the load-bearing decision of
 * FR-075.
 *
 * **The two states have opposite operational meanings.** `cooling_off` means the credential is
 * alive and the provider is busy: it clears on its own, the FR-076 sweep returns the seat to the
 * pool, a run holding it waits the limit out (FR-077), and nothing is raised to anybody.
 * `unhealthy` means the login itself is broken: the credential leaves the pool and stays out until
 * a human repairs it, and an administrator is paged (FR-037, FR-056). Getting the two the wrong way
 * round is not a cosmetic error in either direction, which is why the decision lives in exactly one
 * function that can be tested against recorded responses rather than being spread across the call
 * sites that provoke a failure.
 *
 * ## The asymmetry is deliberate: an ambiguous response is `cooling_off`
 *
 * A credential wrongly moved to `cooling_off` **returns by itself** — the sweep retries it past
 * `cooling_off_until`, or on `SISYPHUS_COOLING_OFF_RETRY_MINUTES` where the provider named no time
 * (FR-078) — and the cost of the mistake is one credential unavailable for one retry interval. A
 * credential wrongly marked `unhealthy` **waits for a person to notice**, and the cost is a seat
 * out of the pool until somebody looks, plus an alert that was not real. The mistakes are not the
 * same size, so the default is the recoverable one. Every response this function cannot positively
 * classify — a 500, a timeout, a body it has never seen — resolves to `cooling_off`.
 *
 * The corollary is that `unhealthy` is only ever returned on a **positive** authentication or
 * authorisation signal. There is no path here where "we do not know" becomes "it is broken".
 *
 * ## Why the limit signal is tested before the auth signal
 *
 * Providers are not consistent about which status a quota exhaustion carries: 429 is the common
 * answer, but a plan or usage limit is also seen as 402 and as 403, and 403 is otherwise the
 * clearest authorisation refusal there is. Testing the limit signal first means a response that
 * carries **both** — a 403 whose body says the usage limit was reached — resolves the recoverable
 * way, which is the same argument the ambiguous default makes.
 *
 * ## Why the reason never quotes the provider's body
 *
 * {@link HealthVerdict.reason} is written to `agent_credentials.last_failure_reason`, which is
 * rendered to administrators verbatim (FR-009). SC-014 wants zero occurrences of credential
 * material on any administrator-visible surface, and the one thing nobody controls about a provider
 * response is what its body contains — an error that echoes the offending header back is a normal
 * thing for an HTTP API to do. So the body is **read** to classify and never **quoted**: the reason
 * is composed from the status, the classification, and the provider's own machine-readable
 * {@link ProviderResponse.code} where it gave one, all three of which are bounded vocabularies.
 *
 * ## Why this names no agent vendor
 *
 * FR-003, applied to code rather than to columns. The signals matched below are the ones the HTTP
 * status vocabulary and ordinary provider English already carry; nothing here is keyed to a
 * particular backend, and a deployment that swaps its agent adapter does not swap this file. The
 * recorded responses that pin the behaviour live in `classify.test.ts`, which is where a real
 * provider's shape belongs — as a fixture, never as a call.
 */

/**
 * A refusal, as recorded from the provider.
 *
 * Every field is optional because every field is genuinely absent in some real case: a connection
 * that never completed has no status and no body, a provider that answers `429` with an empty body
 * has no text, and most have no machine-readable code at all. A shape that demanded them would be a
 * shape the caller had to invent values for, and an invented `status: 0` classifies differently
 * from an absent one.
 */
export interface ProviderResponse {
  /** The HTTP status, or `undefined` when the request never got one. */
  readonly status?: number
  /**
   * Response headers. Matched case-insensitively — `Retry-After` and `retry-after` are the same
   * header, and a map keyed by whatever casing the transport happened to preserve is a map that
   * silently stops matching when the transport changes.
   */
  readonly headers?: Readonly<Record<string, string>>
  /** The response body as text. Read to classify; never quoted into the reason. See the note above. */
  readonly body?: string
  /** The provider's own error code, where it publishes one. Safe to quote: it is a vocabulary. */
  readonly code?: string
}

/** Which of the three things the response was. Recorded so a verdict can be explained later. */
export type ProviderSignal = 'ambiguous' | 'auth_failure' | 'rate_limit'

/** What the response means for the credential. */
export interface HealthVerdict {
  /**
   * Where the credential belongs now. Only these two: `disabled` is an administrator's decision and
   * `available` is not something a refusal can conclude.
   */
  readonly state: Extract<AgentCredential['state'], 'cooling_off' | 'unhealthy'>
  /**
   * When the provider said the limit clears, where it said so at all (FR-078).
   *
   * `undefined` is the case that matters: it means the provider refused without naming a time, and
   * the credential must still be retried on a cadence of ours rather than left cooling off for
   * ever. Never set alongside `unhealthy` — a broken login has no reset time.
   */
  readonly coolingOffUntil: Date | undefined
  /** What was matched, for the trail and for the tests. */
  readonly signal: ProviderSignal
  /** One sentence for an administrator. Composed, never quoted — see the module note. */
  readonly reason: string
}

/** Statuses that are an authentication or authorisation refusal and nothing else. */
const AUTH_STATUSES = new Set([401, 403])

/** Statuses that are a usage or rate limit. `402` is a plan or quota exhaustion, not a breakage. */
const LIMIT_STATUSES = new Set([402, 429])

/**
 * Ordinary provider English for "you have run out", in the words providers actually use.
 *
 * Matched against the body only when the status has not already decided, so a false positive here
 * cannot override an explicit `401`. The list errs towards matching: an over-eager match yields
 * `cooling_off`, which is where an unmatched response was going anyway.
 */
const LIMIT_PHRASES =
  /\b(?:rate[ _-]?limit|usage[ _-]?limit|quota|too many requests|overloaded|capacity|try again later|slow down)\b/i

/**
 * Ordinary provider English for "this login is not good".
 *
 * Deliberately narrower than {@link LIMIT_PHRASES}, because a match here is what takes a credential
 * out of the pool until a human acts. Every entry is a phrase that cannot reasonably describe a
 * healthy credential being throttled.
 */
const AUTH_PHRASES =
  /\b(?:invalid[ _-]?(?:api[ _-]?key|token|credential|grant)|unauthori[sz]ed|authentication[ _-]?(?:failed|error)|not[ _-]?authenticated|expired[ _-]?(?:token|credential|session)|revoked|re-?authenticate|sign(?:ed)?[ _-]?out)\b/i

/** Headers naming a reset, in the order they are believed. */
const RESET_SECONDS_HEADERS = ['retry-after', 'x-ratelimit-reset-after', 'ratelimit-reset']
const RESET_INSTANT_HEADERS = ['x-ratelimit-reset', 'x-ratelimit-reset-requests']

/** Header lookup that does not depend on what casing the transport preserved. */
const headerValue = (
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined => {
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/**
 * A reset instant from whichever header carried one, or `undefined`.
 *
 * Three encodings are in circulation and all three appear in the recorded responses: a delay in
 * whole seconds, an HTTP-date, and an absolute epoch-seconds instant. They are distinguished by
 * shape rather than by header name, because the same header name carries different encodings at
 * different providers — `Retry-After` is specified as either a delay or a date, and reset headers
 * are epoch seconds by convention rather than by any specification.
 *
 * A value that parses to a time **already past** is discarded rather than returned. A deadline in
 * the past would have the FR-076 sweep return the credential on its very next pass, which converts
 * "the provider told us to wait" into "we did not wait at all"; treating it as no stated time
 * instead means the credential waits the configured retry interval, which is the conservative
 * reading and the one that cannot hammer a provider that is already refusing.
 */
const resetInstant = (response: ProviderResponse, now: Date): Date | undefined => {
  for (const name of RESET_SECONDS_HEADERS) {
    const raw = headerValue(response.headers, name)?.trim()
    if (raw === undefined || raw === '') continue

    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(now.getTime() + seconds * 1000)
    }

    // `Retry-After` is specified as a delay *or* an HTTP-date, and providers use both.
    const asDate = new Date(raw)
    if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > now.getTime()) {
      return asDate
    }
  }

  for (const name of RESET_INSTANT_HEADERS) {
    const raw = headerValue(response.headers, name)?.trim()
    if (raw === undefined || raw === '') continue

    const epochSeconds = Number(raw)
    if (Number.isFinite(epochSeconds) && epochSeconds * 1000 > now.getTime()) {
      return new Date(epochSeconds * 1000)
    }

    const asDate = new Date(raw)
    if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > now.getTime()) {
      return asDate
    }
  }

  return undefined
}

/** `status 429`, or `no status`, for the reason sentence. Bounded either way. */
const statusClause = (status: number | undefined): string =>
  status === undefined ? 'no status (the request never completed)' : `status ${String(status)}`

/** ` (code: rate_limit_error)`, or nothing. The code is a vocabulary, so quoting it is safe. */
const codeClause = (code: string | undefined): string => {
  const trimmed = code?.trim()
  return trimmed === undefined || trimmed === '' ? '' : ` The provider named it ${trimmed}.`
}

/**
 * What a provider's refusal means for the credential that produced it.
 *
 * The one exported decision of this directory, and the only place `cooling_off` and `unhealthy` are
 * chosen between. Callers apply the verdict through `transition.ts`; nothing here writes anything,
 * which is what makes it testable against recorded responses rather than against a live provider.
 *
 * @param response - The refusal, as recorded. Every field optional; see {@link ProviderResponse}.
 * @param now - The instant the response was received, for resolving a relative reset. Injectable so
 *   a recorded `Retry-After: 900` has a deterministic deadline in a test.
 * @returns Where the credential belongs, when it may come back, and why — never quoting the body.
 */
export const classifyProviderResponse = (
  response: ProviderResponse,
  now: Date = new Date(),
): HealthVerdict => {
  const { status } = response
  const body = response.body ?? ''
  const until = resetInstant(response, now)

  // First, because the two mistakes are not the same size and a response carrying both signals
  // should resolve the recoverable way. See the module note.
  const isLimit =
    (status !== undefined && LIMIT_STATUSES.has(status)) ||
    LIMIT_PHRASES.test(body) ||
    LIMIT_PHRASES.test(response.code ?? '') ||
    // A reset header is itself a limit signal: nothing else has a reason to send one.
    until !== undefined

  if (isLimit) {
    return {
      state: 'cooling_off',
      coolingOffUntil: until,
      signal: 'rate_limit',
      reason:
        `The provider refused with ${statusClause(status)}, which is a usage or rate limit rather than a broken login.` +
        codeClause(response.code) +
        (until === undefined
          ? ' It named no reset time, so the credential is retried on the configured cooling-off interval.'
          : ` It clears at ${until.toISOString()}.`),
    }
  }

  const isAuthFailure =
    (status !== undefined && AUTH_STATUSES.has(status)) ||
    AUTH_PHRASES.test(body) ||
    AUTH_PHRASES.test(response.code ?? '')

  if (isAuthFailure) {
    return {
      state: 'unhealthy',
      coolingOffUntil: undefined,
      signal: 'auth_failure',
      reason:
        `The provider refused with ${statusClause(status)}, which is an authentication or authorisation failure: the stored login is no longer usable and an administrator must repair it.` +
        codeClause(response.code),
    }
  }

  return {
    state: 'cooling_off',
    coolingOffUntil: undefined,
    signal: 'ambiguous',
    reason:
      `The provider refused with ${statusClause(status)} and the response identified neither a usage limit nor an authentication failure.` +
      codeClause(response.code) +
      ' It is treated as a limit rather than as a breakage, because a credential wrongly cooled off returns by itself while one wrongly marked unhealthy waits for a person.',
  }
}
