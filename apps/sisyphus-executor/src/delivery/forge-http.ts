/* cspell:words ratelimit vnd */
/**
 * **The one module in the delivery path that opens a socket** — the {@link Forge}
 * port, over the code host's REST API (T195, FR-060, FR-077).
 *
 * `./forge.ts` is emphatic that the seam is an interface and not a client, and
 * this file is what that buys: it *is* the construction, nothing else in this
 * directory reaches it, and `pull-request.ts`, `pull-request-set.ts` and their
 * tests go on receiving a `Forge` they did not build and never open a
 * connection. There is no host SDK here and there is not going to be one —
 * three methods over `fetch` is the whole surface, and a vendored SDK would
 * bring several hundred more, including the ones that transition tickets.
 *
 * ## `fetch` is a parameter
 *
 * Injected, defaulting to the global, exactly as the Jira adapter does it.
 * That is what makes this testable at all: every test drives a fake and
 * asserts on the request it was handed, so no test in this directory has ever
 * opened a connection to anything.
 *
 * ## There is no method that transitions a ticket, and no way to add one here
 *
 * FR-060 leaves delivery ownership with the initiating engineer. The port has
 * no such method, so neither does this — and the colocated test asserts the
 * returned object's keys are exactly the three, so a fourth cannot be added
 * quietly.
 *
 * ## Creation is idempotent three times over (FR-077)
 *
 * A retried external action must not produce a duplicate, and a code host does
 * not honour an idempotency key — so the key alone would be a promise nothing
 * keeps. Each layer here covers a different way the duplicate happens:
 *
 * 1. **The key is sent** ({@link IDEMPOTENCY_KEY_HEADER}), for a host or a proxy
 *    that does honour one.
 * 2. **Every attempt looks before it creates.** The find is inside the retried
 *    operation, not before it, so a retry after a lost response sees the pull
 *    request the lost response was reporting.
 * 3. **A conflict is answered by looking again.** `422 already exists` is the
 *    host telling us the previous attempt landed; the answer is to fetch it,
 *    not to fail and not to post again.
 *
 * And in front of all three, creation is memoised on the idempotency key for
 * the lifetime of the client, so two concurrent calls for one run share a
 * single request rather than racing each other into two pull requests.
 *
 * ## The credential
 *
 * A function, resolved per request, so a renewal is picked up by the next call
 * without rebuilding the client — the same shape `run/assemble.ts` already uses
 * for the machine surface. It is closed over rather than held as a field, so
 * nothing downstream can read it back off the returned object. It travels in an
 * `Authorization` header and appears in no URL, no query parameter and no log.
 * Every scrap of host-supplied text that reaches an error message goes through
 * the executor's own known-value redactor built from that credential first, so
 * a host that echoes the header back cannot put it on the panel (FR-072).
 */

import type { Redactor } from '../output'
import { createRedactor } from '../output'

import type { CreatePullRequestInput, Forge, PullRequestRef } from './forge'
import {
  ForgeError,
  httpForgeError,
  isNotFoundForgeError,
  transportForgeError,
} from './forge-error'
import type { RepositorySlug } from './forge-repository'
import { parseRepositorySlug } from './forge-repository'
import type { ForgeRetryPolicy } from './forge-retry'
import { DEFAULT_FORGE_RETRY_POLICY, withForgeRetry } from './forge-retry'

/** Offered to a host or proxy that honours one. See the note above on why it is not the mechanism. */
export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key'

/** Pinned, so a host's default version moving cannot change what this client means. */
export const FORGE_API_VERSION_HEADER = 'x-github-api-version'
export const FORGE_API_VERSION = '2022-11-28'

export const FORGE_ACCEPT = 'application/vnd.github+json'

/** Sent because hosts reject an unidentified client, and it is not a credential. */
export const FORGE_USER_AGENT = 'sisyphus-executor'

/** The label the credential is redacted under. A name, never a shape. */
export const CREDENTIAL_SECRET_NAME = 'repository-host-credential'

export interface HttpForgeOptions {
  /** Base URL of the host's REST API. Trailing slashes are tolerated. */
  readonly apiBaseUrl: string
  /**
   * The repository-host credential the setup bundle installed (FR-075).
   *
   * A function rather than a value so a renewed credential is picked up by the
   * next request, and so this client never becomes a place a credential is
   * stored.
   */
  readonly credential: () => string | Promise<string>
  /** Injected so no test in this directory opens a socket. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch
  readonly retry?: ForgeRetryPolicy
  /** Injected so the rate-limit reset arithmetic is testable. */
  readonly now?: () => number
}

/** `https://api.forge.example/` and `…example` must address the same host. */
const trimBase = (apiBaseUrl: string): string => apiBaseUrl.replace(/\/+$/, '')

/**
 * Percent-encode each segment and keep the separators.
 *
 * A ref path is `heads/sisyphus/ACME-142`: the slashes are structural and must
 * survive, everything else must be escaped so a branch name cannot climb out of
 * the path it was interpolated into.
 */
const encodePath = (value: string): string =>
  value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

interface RefPayload {
  readonly ref?: string
  readonly object?: { readonly sha?: string }
}

interface PullRequestPayload {
  readonly number?: number
  readonly html_url?: string
  readonly draft?: boolean
}

/**
 * The sha a ref lookup reported, or `undefined` if the payload named none.
 *
 * The array branch is for the hosts that answer a ref lookup with every ref
 * sharing the prefix rather than with a 404 — `heads/feature` would otherwise
 * silently return `heads/feature-two`'s commit, which pushed-commit
 * verification would compare against the local head and reject with a
 * confidently wrong message.
 */
export const shaFromRefPayload = (payload: unknown, ref: string): string | undefined => {
  if (Array.isArray(payload)) {
    const exact = (payload as readonly RefPayload[]).find((entry) => entry.ref === `refs/${ref}`)

    return exact?.object?.sha
  }

  return (payload as RefPayload).object?.sha
}

const toPullRequestRef = (payload: PullRequestPayload, operation: string): PullRequestRef => {
  if (payload.number === undefined || payload.html_url === undefined) {
    throw new ForgeError({
      kind: 'invalid',
      operation,
      detail: 'the forge answered without a pull request number and url.',
    })
  }

  return { number: payload.number, url: payload.html_url, isDraft: payload.draft === true }
}

interface RequestSpec {
  readonly operation: string
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A redactor per credential value, rebuilt only when the credential changes.
 *
 * Building one is not free — it expands the value into every encoding
 * `secret-encodings.ts` can derive — and a renewal is rare, so the cache is
 * one entry deep.
 */
const credentialRedactors = (): ((credential: string) => Redactor) => {
  let cachedFor: string | undefined
  let cached: Redactor | undefined

  return (credential: string): Redactor => {
    if (cached === undefined || cachedFor !== credential) {
      cached = createRedactor({ secrets: [{ name: CREDENTIAL_SECRET_NAME, value: credential }] })
      cachedFor = credential
    }

    return cached
  }
}

/**
 * Build the {@link Forge} adapter.
 *
 * @param options - The API base, the credential accessor, and the injected transport.
 * @returns The port, with exactly the three methods it declares.
 */
export const createHttpForge = (options: HttpForgeOptions): Forge => {
  const base = trimBase(options.apiBaseUrl)
  const call = options.fetch ?? globalThis.fetch
  const policy = options.retry ?? DEFAULT_FORGE_RETRY_POLICY
  const now = options.now ?? Date.now
  const redactorFor = credentialRedactors()
  /** Keyed by idempotency key: one run's pull request is requested once. */
  const creations = new Map<string, Promise<PullRequestRef>>()

  const request = async <TResult>(spec: RequestSpec): Promise<TResult> => {
    const credential = await options.credential()
    const { redact } = redactorFor(credential)
    const url = new URL(`${base}${spec.path}`)

    for (const [name, value] of Object.entries(spec.query ?? {})) {
      url.searchParams.set(name, value)
    }

    let response: Response

    try {
      response = await call(url.toString(), {
        method: spec.method ?? 'GET',
        headers: {
          // The credential lives here and nowhere else.
          authorization: `Bearer ${credential}`,
          accept: FORGE_ACCEPT,
          [FORGE_API_VERSION_HEADER]: FORGE_API_VERSION,
          'user-agent': FORGE_USER_AGENT,
          ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...spec.headers,
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      })
    } catch (cause) {
      // The host was never asked. This must never become "no such branch".
      throw transportForgeError(spec.operation, cause, redact)
    }

    if (!response.ok) {
      // Read as text: an error body is not reliably JSON, and a parse failure
      // here would replace a diagnostic status with a syntax error.
      throw httpForgeError({
        operation: spec.operation,
        status: response.status,
        headers: response.headers,
        body: await response.text().catch(() => ''),
        redact,
        nowMs: now(),
      })
    }

    try {
      return (await response.json()) as TResult
    } catch (cause) {
      throw new ForgeError({
        kind: 'invalid',
        operation: spec.operation,
        status: response.status,
        detail: 'the forge answered with something that is not JSON.',
        cause,
      })
    }
  }

  /**
   * `undefined` for `not_found` and for nothing else.
   *
   * The whole point of the error taxonomy in one function: an unauthorised, a
   * throttle or a dead socket propagates, because none of them is the host
   * saying the thing does not exist.
   */
  const optional = async <TResult>(run: () => Promise<TResult>): Promise<TResult | undefined> => {
    try {
      return await run()
    } catch (failure) {
      if (isNotFoundForgeError(failure)) {
        return undefined
      }

      throw failure
    }
  }

  const findOpen = async (input: {
    readonly slug: RepositorySlug
    readonly head: string
    readonly base: string
  }): Promise<PullRequestRef | undefined> => {
    const operation = `findPullRequest ${input.head} → ${input.base} on ${input.slug.path}`
    const payload = await request<readonly PullRequestPayload[]>({
      operation,
      path: `/repos/${encodePath(input.slug.path)}/pulls`,
      query: {
        state: 'open',
        // Qualified with the owner because the filter takes `owner:branch`.
        // Sisyphus pushes the work branch to the repository it proposes onto,
        // so the owner is this repository's; a fork would need its own.
        head: `${input.slug.owner}:${input.head}`,
        base: input.base,
        per_page: '100',
      },
    })

    const [first] = payload

    // An empty page is the host saying there is no open pull request for this
    // pair — which is a fact, not a failure, and the one thing that lets
    // creation proceed.
    return payload.length === 0 ? undefined : toPullRequestRef(first, operation)
  }

  const create = async (input: CreatePullRequestInput): Promise<PullRequestRef> => {
    const slug = parseRepositorySlug(input.repository)
    const operation = `createPullRequest ${input.head} → ${input.base} on ${slug.path}`

    return withForgeRetry(policy, async () => {
      // Look before creating, on **every** attempt (FR-077). A retry after a
      // lost response finds the pull request that response was reporting.
      const existing = await findOpen({ slug, head: input.head, base: input.base })

      if (existing !== undefined) {
        return existing
      }

      try {
        return toPullRequestRef(
          await request<PullRequestPayload>({
            operation,
            path: `/repos/${encodePath(slug.path)}/pulls`,
            method: 'POST',
            body: {
              title: input.title,
              head: input.head,
              base: input.base,
              body: input.body,
              draft: input.draft,
            },
            headers: { [IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey },
          }),
          operation,
        )
      } catch (failure) {
        // "A pull request already exists" arrives as a conflict. That is the
        // host reporting the previous attempt landed, so the answer is to
        // fetch it rather than to post again or to fail the delivery.
        if (failure instanceof ForgeError && failure.kind === 'conflict') {
          const raced = await findOpen({ slug, head: input.head, base: input.base })

          if (raced !== undefined) {
            return raced
          }
        }

        throw failure
      }
    })
  }

  return {
    branchHead: async (input) => {
      const slug = parseRepositorySlug(input.repository)
      const ref = `heads/${input.branch}`
      const operation = `branchHead ${input.branch} on ${slug.path}`

      const payload = await withForgeRetry(policy, async () =>
        optional(async () =>
          request<unknown>({
            operation,
            path: `/repos/${encodePath(slug.path)}/git/ref/${encodePath(ref)}`,
          }),
        ),
      )

      if (payload === undefined) {
        return undefined
      }

      const sha = shaFromRefPayload(payload, ref)

      if (sha === undefined) {
        // The host answered, and its answer names no commit. That is a broken
        // response, not an absent branch — reporting it as absent would tell
        // the engineer their push never happened.
        throw new ForgeError({
          kind: 'invalid',
          operation,
          detail: 'the forge answered the ref lookup without a commit.',
        })
      }

      return sha
    },

    findPullRequest: async (input) =>
      withForgeRetry(policy, async () =>
        findOpen({
          slug: parseRepositorySlug(input.repository),
          head: input.head,
          base: input.base,
        }),
      ),

    createPullRequest: async (input) => {
      const inFlight = creations.get(input.idempotencyKey)

      if (inFlight !== undefined) {
        return inFlight
      }

      const attempt = create(input)

      creations.set(input.idempotencyKey, attempt)

      try {
        return await attempt
      } catch (failure) {
        // A failed creation is forgotten, so a caller that handles the failure
        // and tries again gets a fresh attempt — which will look before it
        // creates, so forgetting cannot produce a duplicate.
        creations.delete(input.idempotencyKey)

        throw failure
      }
    },
  }
}
