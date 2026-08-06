import type {
  JiraCommentPage,
  JiraCommentRecord,
  JiraRestClient,
  JiraSearchPage,
  JiraUser,
} from './client'
import { sanitiseFailure } from './sanitise-failure'

/**
 * **The HTTP adapter for {@link JiraRestClient} — the one thing in this package that opens a socket.**
 *
 * ## Why it lives here and not in the control plane
 *
 * A per-type HTTP client under `apps/sisyphus-control-plane/src/jobs/` would be exactly the thing
 * `connector-registry.ts` exists to prevent: FR-192 says adding a second integration type must
 * require a new package and a registry entry, and nothing else — and a control plane holding a Jira
 * client would need a second one for the next board, in a directory whose own test asserts it never
 * names a board. The client is the deepest Jira-specific thing there is: its paths, its `fields`
 * list, its `startAt`/`maxResults` paging, its v2-versus-v3 body format. All of that belongs beside
 * the seam it satisfies.
 *
 * `client.ts` says nothing in this package constructs an HTTP client for itself, and that stays
 * true: this module *is* the construction, it is not reached by any other module here, and every
 * other file in the package still receives a {@link JiraRestClient} it did not build. The tests for
 * `discover`, `write-back` and `validate` go on running against the recording fake.
 *
 * ## `fetch` is a parameter
 *
 * Injected, defaulting to the global. That is what makes this file testable at all — every test
 * below drives a fake `fetch` and asserts on the request it was handed, so no test in this package
 * has ever opened a connection to anything.
 *
 * ## v2, deliberately
 *
 * `client.ts` states the seam speaks plain text: v3 returns Atlassian Document Format objects for
 * descriptions and comment bodies, v2 returns strings, and rendering ADF into text is a document
 * renderer nobody wants in prompt assembly. So the paths are `/rest/api/2/…` and the bodies are
 * strings, which is the contract the rest of the package is written against.
 *
 * ## The credential is never in an error, and never in a URL
 *
 * It goes in an `Authorization` header and nowhere else — not a query parameter, not the authority
 * of the URL. Every failure this module raises goes through {@link sanitiseFailure} first, so a Jira
 * error body that happens to echo a header cannot reach an integration run record or the panel
 * (FR-072, FR-098). The credential is closed over rather than stored on the returned object, so
 * nothing downstream can read it back off the client.
 *
 * ## There is no transition method, and there will not be one
 *
 * FR-057 leaves which transition to apply to the client's own skills, performed by the executor.
 * The seam has no method for it; neither does this.
 */

/** The API version the seam is written against. See the note above. */
export const JIRA_API_BASE = '/rest/api/2'

/**
 * The issue fields discovery asks for.
 *
 * Named rather than left to Jira's default, because the default is *every* field on the screen —
 * hundreds of them on a mature board, most of them custom, all of them paid for in response size on
 * every page of every tick. `comment` is included because `toCandidateItem` reads the ticket's
 * comments into the prompt; everything else is what `./candidate.ts` projects.
 */
export const DISCOVERY_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'project',
  'components',
  'labels',
  'assignee',
  'comment',
] as const

export interface JiraHttpClientOptions {
  /** The board's base URL, `https://acme.atlassian.net`. Trailing slashes are tolerated. */
  readonly baseUrl: string
  /**
   * The board credential, read from the secret store for this call and never cached to disk
   * (FR-072).
   *
   * Two accepted forms, distinguished by the colon, because the two Jira deployments authenticate
   * differently and an adapter that assumed one would fail against the other with a `401` an admin
   * could not act on:
   *
   * - `email@example.com:api-token` — Jira Cloud, sent as HTTP Basic.
   * - anything without a colon — a personal access token, sent as `Bearer`.
   */
  readonly credential: string
  /** Injected so this package's tests never open a socket. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch
}

/** How a credential is presented. Derived from its shape; see {@link JiraHttpClientOptions}. */
export const authorisationHeader = (credential: string): string => {
  const separator = credential.indexOf(':')

  return separator === -1
    ? `Bearer ${credential}`
    : `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`
}

/** `https://acme.atlassian.net/` and `https://acme.atlassian.net` must address the same board. */
const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

/**
 * A failed request, as a sentence.
 *
 * The status is named because it is the diagnostic — `401` is a wrong token and `400` is usually a
 * JQL mistake — and a bounded excerpt of the body follows it, redacted. The URL is **not** included:
 * it carries the JQL, which carries the board's configuration, and the status plus the operation is
 * enough to act on.
 */
export const requestFailedError = (operation: string, status: number, body: string): Error =>
  new Error(sanitiseFailure(`Jira ${operation} failed with HTTP ${String(status)}. ${body}`.trim()))

interface RequestOptions {
  readonly operation: string
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Build the adapter for one board.
 *
 * @param options - See {@link JiraHttpClientOptions}.
 */
export const createJiraHttpClient = (options: JiraHttpClientOptions): JiraRestClient => {
  const base = trimBase(options.baseUrl)
  const authorisation = authorisationHeader(options.credential)
  const call = options.fetch ?? globalThis.fetch

  const request = async <TResult>(request: RequestOptions): Promise<TResult> => {
    const url = new URL(`${base}${JIRA_API_BASE}${request.path}`)

    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(name, value)
    }

    const response = await call(url.toString(), {
      method: request.method ?? 'GET',
      headers: {
        // The credential lives here and nowhere else.
        authorization: authorisation,
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })

    if (!response.ok) {
      // Read as text: an error body is not reliably JSON, and a parse failure here would replace a
      // diagnostic status with a syntax error.
      throw requestFailedError(
        request.operation,
        response.status,
        await response.text().catch(() => ''),
      )
    }

    return (await response.json()) as TResult
  }

  return {
    currentUser: async () => request<JiraUser>({ operation: 'currentUser', path: '/myself' }),

    searchIssues: async (input) =>
      request<JiraSearchPage>({
        operation: 'searchIssues',
        path: '/search',
        query: {
          jql: input.jql,
          startAt: String(input.startAt),
          maxResults: String(input.maxResults),
          fields: DISCOVERY_FIELDS.join(','),
        },
      }),

    listComments: async (input) =>
      request<JiraCommentPage>({
        operation: 'listComments',
        // Oldest first, which is the order `./write-back.ts` pages in and the order a marker search
        // wants: the platform's own comment on a ticket is normally its first.
        path: `/issue/${encodeURIComponent(input.issueKey)}/comment`,
        query: {
          startAt: String(input.startAt),
          maxResults: String(input.maxResults),
          orderBy: 'created',
        },
      }),

    addComment: async (input) =>
      request<JiraCommentRecord>({
        operation: 'addComment',
        path: `/issue/${encodeURIComponent(input.issueKey)}/comment`,
        method: 'POST',
        body: { body: input.body },
        // Offered to the deployments that honour one. `./write-back.ts` looks before it creates and
        // looks again after a failure, so a deployment that ignores this header is still covered —
        // the remote's cooperation is a bonus here, never the mechanism.
        headers: { 'x-idempotency-key': input.idempotencyKey },
      }),
  }
}
