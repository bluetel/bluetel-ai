/**
 * **The real {@link InstanceMetadataReader}, against the instance metadata service (T197, T240,
 * FR-054).**
 *
 * `./interruption.ts` is careful to say what it cannot prove: the watch, the deduplication and the
 * routing into `suspend()` are all decided against an interface, and until this module existed the
 * only implementation behind that interface was {@link createQuietMetadataReader} — a reader that
 * answers `null` forever. `run/execute.ts` defaulted to it, so on a real instance the watch polled
 * a stub every five seconds and no reclamation was ever detected.
 *
 * That is not an edge case, and T240 exists to correct the record on why. Interruptible capacity is
 * the **default** purchase mode — `packages/sisyphus-api/src/enums/purchase-mode.ts` sets
 * `DEFAULT_PURCHASE_MODE = 'spot'`, and 003/FR-039 states it as the platform default — so a
 * workflow launched with nothing specified runs on capacity that can be reclaimed with about two
 * minutes' warning. With the quiet reader in place that warning was read by nobody and the run was
 * lost with its uncommitted working tree. Silent data loss in the configuration everybody gets.
 *
 * ## IMDSv2, because IMDSv1 is not reachable on a hardened instance
 *
 * The notice lives at `/latest/meta-data/spot/instance-action` on the link-local address
 * `169.254.169.254`. Version 2 of the service is session-oriented: a `PUT` to
 * {@link IMDS_TOKEN_PATH} carrying {@link IMDS_TOKEN_TTL_HEADER} returns an opaque token, and every
 * subsequent `GET` must present it in {@link IMDS_TOKEN_HEADER}. Instances configured to require
 * IMDSv2 answer an unauthenticated `GET` with `401`, so a v1-style read would look exactly like a
 * broken metadata service — and, worse, would look like it forever.
 *
 * The token is cached for its lifetime less {@link TOKEN_RENEWAL_MARGIN_MS}, so a poll every five
 * seconds is one `PUT` every six hours rather than two requests every poll. A `401` or `403` on the
 * read is treated as "the token went stale earlier than the arithmetic thought" and answered by
 * fetching a fresh one and retrying **once** — not by looping, which would turn a genuinely
 * misconfigured instance into a request storm.
 *
 * ## `404` is the answer, not a failure
 *
 * This is the single most important thing in the file. While no reclamation has been scheduled the
 * endpoint answers `404`, and that is the *normal* case — it is what the service says several
 * million times for every once it says anything else. Counting it as a read failure would make
 * `readFailures` climb forever and drown the one signal that matters; throwing on it would make
 * every poll of a perfectly healthy instance an error. So `404` maps to `null`, exactly as
 * {@link InstanceMetadataReader} documents, and nothing else does.
 *
 * Every other outcome is a rejection, because {@link InstanceMetadataReader} is explicit that
 * rejecting is not the same as `null`: a metadata service that cannot be reached must never be read
 * as "no notice". `watchForInterruption` counts and reports those rejections and carries on
 * polling, which is why an unreachable IMDS degrades into a visible warning rather than a crashed
 * run or a false all-clear.
 *
 * ## A deadline on every read, because this runs on a polling loop
 *
 * The link-local address is a black hole on anything that is not an EC2 instance: a connection to
 * it can hang until the operating system gives up, which is far longer than the poll interval and
 * unboundedly longer than the two minutes a reclamation notice buys. So each read runs under
 * {@link DEFAULT_IMDS_TIMEOUT_MS}, enforced two ways at once — the {@link AbortSignal} handed to
 * the transport, *and* a race against a timer. The signal alone would be enough for a well-behaved
 * `fetch`; the race is what makes the guarantee hold for a transport that ignores it, and this is
 * the one seam in the module where a hang would silently cost the run its snapshot.
 *
 * ## The transport is a parameter
 *
 * Defaulting to the global `fetch`, exactly as `delivery/forge-http.ts` does it. No test in this
 * directory opens a socket, and no test needs a real instance to prove that a `404` means "not
 * interrupted".
 */

import type { InstanceMetadataReader, InterruptionNotice } from './interruption'
import { codedError } from './snapshot-store'

/** The link-local address every EC2 instance answers metadata on. Not routable off the instance. */
export const IMDS_BASE_URL = 'http://169.254.169.254'

/** IMDSv2's session endpoint. A `PUT`, deliberately: a `GET` here would be cross-site reachable. */
export const IMDS_TOKEN_PATH = '/latest/api/token'

/** Where a scheduled reclamation appears. `404` until one is scheduled. */
export const IMDS_SPOT_ACTION_PATH = '/latest/meta-data/spot/instance-action'

export const IMDS_TOKEN_TTL_HEADER = 'x-aws-ec2-metadata-token-ttl-seconds'
export const IMDS_TOKEN_HEADER = 'x-aws-ec2-metadata-token'

/**
 * Six hours, the maximum the service allows.
 *
 * Long on purpose. The token is not a credential for anything outside this instance, and a short
 * one would mean a `PUT` interleaved with the reads for no benefit — including, on the worst
 * possible schedule, one that fails during the two minutes the notice gives.
 */
export const DEFAULT_IMDS_TOKEN_TTL_SECONDS = 21_600

/**
 * Renew a minute before the token is actually due to expire.
 *
 * Clock skew between this process's `Date.now()` and the service's own expiry is small but not
 * zero, and the cost of being wrong in the optimistic direction is a `401` on the poll that
 * mattered. A minute is free.
 */
export const TOKEN_RENEWAL_MARGIN_MS = 60_000

/**
 * One second, against a five-second poll interval and a two-minute notice period.
 *
 * Generous for a link-local request that never leaves the host, and short enough that a metadata
 * service which has stopped answering costs a fifth of the interval rather than the run.
 */
export const DEFAULT_IMDS_TIMEOUT_MS = 1_000

/** The metadata service could not be reached at all. Counted by the watch, never read as "no notice". */
export const IMDS_UNREACHABLE = 'E_IMDS_UNREACHABLE'

/** The read did not answer inside {@link DEFAULT_IMDS_TIMEOUT_MS}. Distinct, so a hang is diagnosable. */
export const IMDS_TIMEOUT = 'E_IMDS_TIMEOUT'

/** A status that is neither `200` nor `404` — including a `401` that survived a token refresh. */
export const IMDS_UNEXPECTED_STATUS = 'E_IMDS_UNEXPECTED_STATUS'

/**
 * What {@link InterruptionNotice.action} carries when the payload named none.
 *
 * Never `null` and never a reason to discard the notice. See {@link parseInstanceAction}.
 */
export const UNKNOWN_INSTANCE_ACTION = 'unknown'

/** Statuses that mean "your token is not acceptable", which is recoverable exactly once. */
const TOKEN_REJECTED_STATUSES: readonly number[] = [401, 403]

interface InstanceActionPayload {
  readonly action?: unknown
  readonly time?: unknown
}

/**
 * Turn a `200` body into a notice.
 *
 * Exported because the decisions in here are the ones worth reading, and all of them lean the same
 * way: **a `200` from this endpoint is a notice**, whatever it contains. The service does not
 * answer `200` unless a reclamation has been scheduled, so a body that will not parse, a missing `time` or
 * an `action` string this executor has not seen before are all reasons to be *less* sure of the
 * details and none of them are reasons to conclude there is no notice — that conclusion is how a
 * run gets reclaimed unsnapshotted, which is the failure FR-054 exists to prevent.
 *
 * So an unreadable `time` falls back to `receivedAt`, i.e. "assume it is imminent". A snapshot
 * taken sooner than it needed to be costs a few seconds; one taken later than the instance existed
 * costs the working tree.
 *
 * @param body - The response body, verbatim.
 * @param receivedAt - When the answer arrived, used as the pessimistic reclamation time.
 * @returns The notice. This function has no "not a notice" return value, by design.
 */
export const parseInstanceAction = (body: string, receivedAt: Date): InterruptionNotice => {
  let payload: unknown

  try {
    payload = JSON.parse(body)
  } catch {
    // A `200` whose body is not JSON is still a `200`. Fall through with nothing parsed.
    payload = undefined
  }

  const record: InstanceActionPayload =
    typeof payload === 'object' && payload !== null ? (payload as InstanceActionPayload) : {}

  const action =
    typeof record.action === 'string' && record.action.length > 0
      ? record.action
      : UNKNOWN_INSTANCE_ACTION

  const stated = typeof record.time === 'string' ? new Date(record.time) : undefined
  const reclaimAt =
    stated !== undefined && !Number.isNaN(stated.getTime()) ? stated : new Date(receivedAt)

  return { reclaimAt, action }
}

export interface ImdsMetadataReaderOptions {
  /** Defaults to {@link IMDS_BASE_URL}. Trailing slashes are tolerated. */
  readonly baseUrl?: string
  /** Injected so no test in this directory opens a socket. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch
  /** Per-read deadline. Defaults to {@link DEFAULT_IMDS_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Requested token lifetime. Defaults to {@link DEFAULT_IMDS_TOKEN_TTL_SECONDS}. */
  readonly tokenTtlSeconds?: number
  /** Injected so the token-expiry arithmetic is testable without waiting six hours. */
  readonly now?: () => number
}

interface CachedToken {
  readonly value: string
  readonly renewAfterMs: number
}

/** `http://169.254.169.254/` and `…254` must address the same service. */
const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/u, '')

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Run `work` under a hard deadline.
 *
 * Both halves matter. The signal lets a cooperative transport abandon the socket rather than leave
 * it open behind us; the race is what makes the deadline a guarantee rather than a request, which
 * is the property the polling loop actually depends on.
 */
const withDeadline = async <TResult>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<TResult>,
): Promise<TResult> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(
        codedError(IMDS_TIMEOUT, `instance metadata did not answer within ${String(timeoutMs)}ms.`),
      )
    }, timeoutMs)
    timer.unref()
  })

  const running = work(controller.signal)
  // If the deadline wins, the aborted request rejects with nobody left to catch it. Claim it here
  // so a timeout does not also become an unhandled rejection.
  running.catch(() => undefined)

  try {
    return await Promise.race([running, expiry])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the real reader.
 *
 * Holds one piece of state — the cached IMDSv2 token — and exposes the single method
 * {@link InstanceMetadataReader} declares. Nothing else about the instance is readable through it,
 * for the reason `interruption.ts` gives: this seam exists to be replaceable, and a reader that
 * also handed out the instance id would invite the rest of the executor to reach through it.
 *
 * @param options - See {@link ImdsMetadataReaderOptions}. Every field has a working default.
 * @returns A reader that answers `null` while no reclamation is scheduled and rejects when the
 *   service cannot be read.
 */
export const createImdsMetadataReader = (
  options: ImdsMetadataReaderOptions = {},
): InstanceMetadataReader => {
  const base = trimBase(options.baseUrl ?? IMDS_BASE_URL)
  const call = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMDS_TIMEOUT_MS
  const ttlSeconds = options.tokenTtlSeconds ?? DEFAULT_IMDS_TOKEN_TTL_SECONDS
  const now = options.now ?? Date.now

  let cached: CachedToken | undefined

  const requestToken = async (signal: AbortSignal): Promise<string> => {
    let response: Response

    try {
      response = await call(`${base}${IMDS_TOKEN_PATH}`, {
        method: 'PUT',
        headers: { [IMDS_TOKEN_TTL_HEADER]: String(ttlSeconds) },
        signal,
      })
    } catch (cause) {
      throw codedError(
        IMDS_UNREACHABLE,
        `instance metadata token request failed: ${describeCause(cause)}`,
      )
    }

    if (!response.ok) {
      throw codedError(
        IMDS_UNEXPECTED_STATUS,
        `instance metadata answered ${String(response.status)} to the token request.`,
      )
    }

    const value = (await response.text()).trim()

    if (value.length === 0) {
      throw codedError(IMDS_UNEXPECTED_STATUS, 'instance metadata issued an empty token.')
    }

    cached = { value, renewAfterMs: now() + ttlSeconds * 1_000 - TOKEN_RENEWAL_MARGIN_MS }

    return value
  }

  const tokenFor = async (signal: AbortSignal): Promise<string> =>
    cached !== undefined && now() < cached.renewAfterMs ? cached.value : requestToken(signal)

  const readAction = async (token: string, signal: AbortSignal): Promise<Response> => {
    try {
      return await call(`${base}${IMDS_SPOT_ACTION_PATH}`, {
        method: 'GET',
        headers: { [IMDS_TOKEN_HEADER]: token },
        signal,
      })
    } catch (cause) {
      throw codedError(IMDS_UNREACHABLE, `instance metadata read failed: ${describeCause(cause)}`)
    }
  }

  const read = async (signal: AbortSignal): Promise<InterruptionNotice | null> => {
    let response = await readAction(await tokenFor(signal), signal)

    if (TOKEN_REJECTED_STATUSES.includes(response.status)) {
      // The token expired earlier than the arithmetic expected, or the instance was told to
      // require IMDSv2 after this reader started. One fresh token, one retry, then it is a fault.
      cached = undefined
      response = await readAction(await requestToken(signal), signal)
    }

    // The whole point of the module. See the header: this is what a healthy instance says.
    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw codedError(
        IMDS_UNEXPECTED_STATUS,
        `instance metadata answered ${String(response.status)} reading the reclamation notice.`,
      )
    }

    // A body that cannot be read is not a reason to discard a `200`. `parseInstanceAction` treats
    // an empty body as a notice with an imminent reclamation, which is the safe direction.
    const body = await response.text().catch(() => '')

    return parseInstanceAction(body, new Date(now()))
  }

  return {
    readInterruptionNotice: () => withDeadline(timeoutMs, read),
  }
}
