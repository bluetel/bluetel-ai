/* cspell:words vnd */
/**
 * **The review workflow's half of the code host** — posting findings, and reading a pull request's
 * state (T196, FR-063, FR-076, FR-077, FR-080).
 *
 * ## Why this is not two more methods on `Forge`
 *
 * `forge.ts` says it plainly: the {@link Forge} port has no method that could write anything a
 * delegated run must not write, and `review-outcome.ts` says the same thing from the other end —
 * "adding a comment method there would give every caller of the delivery path the ability to post
 * one". `forge-http.ts`'s colocated test asserts that `createHttpForge` returns exactly three keys,
 * so a fourth cannot be added quietly even by accident.
 *
 * That constraint is worth keeping, so this is a second client rather than a bigger one. A
 * delegated run is handed a `Forge` and there is nothing on it that posts a comment; a review run
 * is handed this as well. The capability is granted by what the composition root passes, and
 * FR-060 stays a shape rather than a rule somebody has to remember.
 *
 * The request plumbing is shared rather than copied: the error taxonomy (`forge-error.ts`), the
 * retry policy (`forge-retry.ts`) and the slug parser (`forge-repository.ts`) are the same modules
 * `forge-http.ts` uses, so a rate-limited comment and a rate-limited pull request behave the same
 * way and are explained by the same sentence.
 *
 * ## Its types are declared here rather than imported, and that is not laziness
 *
 * `FindingsPublisher` and `ReviewTargetProbe` live in `src/workflows`, and `src/workflows` imports
 * `src/delivery`. Importing back would make the two directories mutually dependent for the sake of
 * two structural shapes. So the shapes are restated, structurally identical, and the composition
 * root's assignment is what checks them — the same trick `iteration-record.ts` uses to avoid
 * `src/report`.
 *
 * ## Idempotency, and the one thing this client cannot do
 *
 * FR-077 requires that a retry cannot produce a duplicate comment. Unlike a pull request, a comment
 * has **no natural identity** on the host: two identical comments are two comments, and there is no
 * "find the open one" query that distinguishes this run's from a human's. `forge-http.ts` gets
 * three layers of protection for creation and this gets one and a half:
 *
 * 1. **The durable claim.** `applyReviewOutcome` posts through `performExternalAction`, which
 *    claims `(run, repository, pull request)` against `external_actions` on the machine surface
 *    *before* this client is called and replays the recorded result afterwards (FR-076). That is
 *    the mechanism, and it survives a re-provisioned instance, which is the case an in-process
 *    guard cannot cover.
 * 2. **The key is sent** ({@link IDEMPOTENCY_KEY_HEADER}), for a host or proxy that honours one.
 *
 * What is deliberately absent is a "look before you post" pass. It would have to match on the
 * comment's *text* — the only thing a host will tell us about it — and the text is the agent's,
 * composed per the skill; matching on it would make a review that legitimately repeats a finding
 * indistinguishable from a retry. The alternative, embedding a hidden key marker in the body, means
 * the platform writing into a comment a customer reads, which FR-063 does not ask for. So the claim
 * is the mechanism and this comment says so, rather than a third layer that looked like one.
 */

import type { Redactor } from '../output'
import { createRedactor } from '../output'

import { ForgeError, httpForgeError, transportForgeError } from './forge-error'
import {
  FORGE_ACCEPT,
  FORGE_API_VERSION,
  FORGE_API_VERSION_HEADER,
  FORGE_USER_AGENT,
  IDEMPOTENCY_KEY_HEADER,
} from './forge-http'
import { parseRepositorySlug } from './forge-repository'
import type { ForgeRetryPolicy } from './forge-retry'
import { DEFAULT_FORGE_RETRY_POLICY, withForgeRetry } from './forge-retry'

/** The label the credential is redacted under here. A name, never a shape. */
export const REVIEW_CREDENTIAL_SECRET_NAME = 'repository-host-credential'

/**
 * What a pull request looks like to a review.
 *
 * `state` is the host's own vocabulary narrowed to the four `ReviewTargetState` values in
 * `workflows/review-guard.ts`. `unknown` is reachable and is the honest answer for a host that
 * reports something this client does not recognise — the guard treats it as "not dead", which is
 * the safe direction: refusing to review because a state string was unfamiliar would turn a host
 * upgrade into a run that did nothing and called it success.
 */
export interface ReviewedPullRequest {
  readonly number: number
  readonly url: string
  readonly state: 'open' | 'closed' | 'merged' | 'unknown'
}

/** Structurally `workflows`' `ReviewCommentRef`; see the module note on why it is restated. */
export interface PostedReviewComment {
  readonly repository: string
  readonly pullRequestNumber: number
  readonly url: string
}

/** Structurally `workflows`' `FindingsPublisher`. */
export type PublishFindings = (input: {
  readonly repository: string
  readonly pullRequestNumber: number
  readonly body: string
  readonly idempotencyKey: string
}) => Promise<PostedReviewComment>

export interface ReviewForge {
  /**
   * What the host currently says about one pull request.
   *
   * Throws rather than answering `undefined` for a pull request the host does not have. A review
   * run was told to review this one; "there is no such pull request" is a fact somebody has to act
   * on, and flattening it into a state would put it in front of the guard as something to continue
   * past.
   */
  readonly readPullRequest: (input: {
    readonly repository: string
    readonly pullRequestNumber: number
  }) => Promise<ReviewedPullRequest>
  readonly publishFindings: PublishFindings
}

export interface HttpReviewForgeOptions {
  /** Base URL of the host's REST API. Trailing slashes are tolerated. */
  readonly apiBaseUrl: string
  /**
   * The repository-host credential the setup bundle installed (FR-075).
   *
   * A function rather than a value so a renewed credential is picked up by the next request, and so
   * this client never becomes a place a credential is stored.
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

/** Percent-encode each segment and keep the separators; see `forge-http.ts`. */
const encodePath = (value: string): string =>
  value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

interface PullRequestStatePayload {
  readonly number?: number
  readonly html_url?: string
  readonly state?: string
  readonly merged?: boolean
  readonly merged_at?: string | null
}

interface CommentPayload {
  readonly html_url?: string
}

/**
 * The host's answer, narrowed to what FR-080 turns on.
 *
 * `merged` is read before `state` and from two fields, because a merged pull request is reported as
 * `state: "closed"` by every host this client speaks to — and "closed" and "merged" are different
 * facts about whether the work landed. Reading only `state` would record every merge as a
 * cancellation.
 */
export const reviewTargetStateFrom = (
  payload: PullRequestStatePayload,
): ReviewedPullRequest['state'] => {
  if (payload.merged === true || (payload.merged_at ?? null) !== null) {
    return 'merged'
  }

  if (payload.state === 'open') {
    return 'open'
  }

  return payload.state === 'closed' ? 'closed' : 'unknown'
}

/** A redactor per credential value, rebuilt only when the credential changes; see `forge-http.ts`. */
const credentialRedactors = (): ((credential: string) => Redactor) => {
  let cachedFor: string | undefined
  let cached: Redactor | undefined

  return (credential: string): Redactor => {
    if (cached === undefined || cachedFor !== credential) {
      cached = createRedactor({
        secrets: [{ name: REVIEW_CREDENTIAL_SECRET_NAME, value: credential }],
      })
      cachedFor = credential
    }

    return cached
  }
}

interface RequestSpec {
  readonly operation: string
  readonly path: string
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Build the review-side client.
 *
 * @param options - The API base, the credential accessor, and the injected transport.
 * @returns The two capabilities a review run needs from the host, and no others.
 */
export const createHttpReviewForge = (options: HttpReviewForgeOptions): ReviewForge => {
  const base = trimBase(options.apiBaseUrl)
  const call = options.fetch ?? globalThis.fetch
  const policy = options.retry ?? DEFAULT_FORGE_RETRY_POLICY
  const now = options.now ?? Date.now
  const redactorFor = credentialRedactors()

  const request = async <TResult>(spec: RequestSpec): Promise<TResult> => {
    const credential = await options.credential()
    const { redact } = redactorFor(credential)
    const url = new URL(`${base}${spec.path}`)

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
      // The host was never asked. This must never become "the pull request is closed".
      throw transportForgeError(spec.operation, cause, redact)
    }

    if (!response.ok) {
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

  return {
    readPullRequest: async (input) => {
      const slug = parseRepositorySlug(input.repository)
      const operation = `readPullRequest #${String(input.pullRequestNumber)} on ${slug.path}`

      const payload = await withForgeRetry(policy, async () =>
        request<PullRequestStatePayload>({
          operation,
          path: `/repos/${encodePath(slug.path)}/pulls/${String(input.pullRequestNumber)}`,
        }),
      )

      if (payload.number === undefined || payload.html_url === undefined) {
        throw new ForgeError({
          kind: 'invalid',
          operation,
          detail: 'the forge answered without a pull request number and url.',
        })
      }

      return {
        number: payload.number,
        url: payload.html_url,
        state: reviewTargetStateFrom(payload),
      }
    },

    publishFindings: async (input) => {
      const slug = parseRepositorySlug(input.repository)
      const operation = `publishFindings on ${slug.path}#${String(input.pullRequestNumber)}`

      // The pull request's conversation, not a diff thread: a review's findings are anchored in
      // their own text (entry, file, line) and a set-wide finding belongs to no diff at all. A
      // line-anchored comment would have to invent a diff position for those, and a wrong position
      // is a customer-visible comment attached to the wrong code.
      const payload = await withForgeRetry(policy, async () =>
        request<CommentPayload>({
          operation,
          path: `/repos/${encodePath(slug.path)}/issues/${String(input.pullRequestNumber)}/comments`,
          method: 'POST',
          body: { body: input.body },
          headers: { [IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey },
        }),
      )

      if (payload.html_url === undefined) {
        // The comment may well have landed. Saying so is the point: the claim recorded against
        // `external_actions` before this call is what stops a retry posting a second one, and a
        // caller told "it failed" without that sentence would reasonably assume nothing happened.
        throw new ForgeError({
          kind: 'invalid',
          operation,
          detail:
            'the forge accepted the comment and answered without a url, so there is no reference ' +
            'to record for it. The action is already claimed, so a retry will not post a second.',
        })
      }

      return {
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        url: payload.html_url,
      }
    },
  }
}
