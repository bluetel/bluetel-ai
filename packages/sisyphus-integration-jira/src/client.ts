/* cspell:words issuetype */
/**
 * The Jira seam — everything this connector may ask of a Jira deployment, and nothing else.
 *
 * Four methods, against a REST API that exposes several hundred. That is deliberate:
 *
 * - **It is an interface, not a client.** Nothing in this package constructs an HTTP client for
 *   itself; one is handed in. So every test in this package runs against
 *   {@link import('./client-fake').createFakeJiraClient} and none of them opens a socket, which is
 *   what makes "what happens when the connection dies after Jira accepted the comment" a case we
 *   can actually assert on rather than reason about.
 * - **It cannot transition an issue.** FR-057 leaves which transition to apply to the client's own
 *   skills, performed by the executor. A connector that could transition would be a connector that
 *   encodes one client's board workflow, so the capability is absent rather than merely unused —
 *   the same way `Forge` in the executor's delivery path has no method that rebases.
 * - **It speaks plain text.** Jira's v3 REST API returns document objects for descriptions and
 *   comment bodies; v2 returns strings. The adapter is expected to take v2 (or to render), so no
 *   document renderer leaks into prompt assembly.
 *
 * **The credential is not here.** An implementation is constructed with one, read from the secret
 * store at call time and never cached to disk (FR-072), and nothing in this file names it — so no
 * function in this package can log it, because none of them can see it.
 */

/** A Jira user, as far as this connector cares: an identity, possibly partly redacted. */
export interface JiraUser {
  /** Stable. Absent for app authors on some deployments. */
  readonly accountId?: string
  /** Absent when the caller lacks the profile-visibility permission. */
  readonly emailAddress?: string
  readonly displayName?: string
}

export interface JiraCommentRecord {
  readonly id: string
  readonly author?: JiraUser
  /** Plain text. See the note on v2 above. */
  readonly body?: string
  /** ISO 8601, as Jira renders it. */
  readonly created?: string
}

/**
 * The issue fields this connector reads.
 *
 * Every one is optional, because every one of them can be absent: a field can be unavailable on
 * the project's screen, hidden by a permission scheme, or simply unset. Modelling them as
 * required and trusting Jira to fill them in is how a connector throws on somebody's board at
 * three in the morning.
 */
export interface JiraIssueFields {
  readonly summary?: string | null
  readonly description?: string | null
  readonly status?: { readonly name?: string } | null
  readonly issuetype?: { readonly name?: string } | null
  readonly project?: { readonly key?: string } | null
  readonly components?: readonly { readonly name?: string }[] | null
  readonly labels?: readonly string[] | null
  readonly assignee?: JiraUser | null
  readonly comment?: { readonly comments?: readonly JiraCommentRecord[] } | null
}

export interface JiraIssue {
  readonly id?: string
  /** The human key, `SIS-123`. The claim key, so an issue without one is unusable (FR-102). */
  readonly key?: string
  readonly fields?: JiraIssueFields
}

export interface JiraSearchPage {
  readonly issues: readonly JiraIssue[]
  readonly startAt?: number
  readonly maxResults?: number
  /** Absent on the newer paginated endpoints, which report {@link JiraSearchPage.isLast}. */
  readonly total?: number
  readonly isLast?: boolean
}

export interface JiraCommentPage {
  readonly comments: readonly JiraCommentRecord[]
  readonly startAt?: number
  readonly maxResults?: number
  readonly total?: number
}

export interface JiraRestClient {
  /**
   * Who the credential authenticates as.
   *
   * Two jobs: it is the cheapest call that proves the deployment is reachable *and* the credential
   * is accepted (FR-097), and it is where the platform's own identity comes from when the
   * integration has not been told it explicitly — which is what FR-161's exclusion turns on.
   */
  readonly currentUser: () => Promise<JiraUser>

  /** One page of a JQL search. Paging is the caller's; this returns exactly what it was asked for. */
  readonly searchIssues: (input: {
    readonly jql: string
    readonly startAt: number
    readonly maxResults: number
  }) => Promise<JiraSearchPage>

  /** One page of an issue's comments, oldest first. */
  readonly listComments: (input: {
    readonly issueKey: string
    readonly startAt: number
    readonly maxResults: number
  }) => Promise<JiraCommentPage>

  /**
   * Post a comment.
   *
   * The idempotency key is passed to the deployment for the deployments that honour one. A
   * deployment that ignores it is still covered, because `./write-back` looks before it creates
   * and looks again after a failure — a remote's cooperation is a bonus here, never the mechanism.
   */
  readonly addComment: (input: {
    readonly issueKey: string
    readonly body: string
    readonly idempotencyKey: string
  }) => Promise<JiraCommentRecord>
}
