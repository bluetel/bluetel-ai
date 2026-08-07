import type {
  JiraCommentPage,
  JiraCommentRecord,
  JiraIssue,
  JiraRestClient,
  JiraSearchPage,
  JiraUser,
} from './client'

/**
 * Recording fake for {@link JiraRestClient}.
 *
 * One fake, exported from the package barrel, so every test in this package — and the control
 * plane's, when it comes to wire the connector up — drives the same one rather than inventing a
 * stub apiece. It records rather than merely responding, because most of what is worth asserting
 * here is about the *calls*: that discovery paged instead of asking for everything at once, that
 * write-back looked before it created, that a retry did not post a second comment.
 *
 * It also models the failure that idempotency exists for. `addCommentBehaviour:
 * 'land-then-throw'` appends the comment and *then* throws, which is a connection that died after
 * Jira accepted the request — indistinguishable, from the caller's side, from a request Jira never
 * saw. A fake that could only succeed or only fail could not express it, and the look-again-after
 * failure step would go untested.
 */

export interface FakeJiraSearch {
  readonly jql: string
  readonly startAt: number
  readonly maxResults: number
}

export interface FakeJiraCommentPost {
  readonly issueKey: string
  readonly body: string
  readonly idempotencyKey: string
}

export type FakeAddCommentBehaviour =
  /** Normal. */
  | 'succeed'
  /** Rejected outright — nothing was created. */
  | 'throw'
  /** Accepted, then the response was lost. The case a retry must not duplicate. */
  | 'land-then-throw'

export interface FakeJiraClientOptions {
  /** Who the credential authenticates as. Throwing here is an unreachable deployment. */
  readonly currentUser?: JiraUser
  readonly issues?: readonly JiraIssue[]
  /** Existing comments per issue key, oldest first. */
  readonly comments?: Readonly<Record<string, readonly JiraCommentRecord[]>>
  /** Whom `addComment` records as the author — the platform's own identity, normally. */
  readonly commentAuthor?: JiraUser
  readonly currentUserError?: Error
  readonly searchError?: Error
  readonly listCommentsError?: Error
  readonly addCommentBehaviour?: FakeAddCommentBehaviour
}

export interface FakeJiraClient extends JiraRestClient {
  /** Every search, in order — the record a pagination assertion is made against. */
  readonly searches: readonly FakeJiraSearch[]
  /** Every comment actually posted, in order. Length 2 for one write-back is the bug. */
  readonly posted: readonly FakeJiraCommentPost[]
  /** How many times the credential's identity was asked for. */
  readonly currentUserCalls: () => number
  /** Comment-listing calls per issue key, so a test can hold "looked before creating". */
  readonly commentReads: readonly string[]
  /** The comments an issue now has, including any this fake accepted. */
  readonly commentsOn: (issueKey: string) => readonly JiraCommentRecord[]
}

const PAGE_FLOOR = 1

export const createFakeJiraClient = (options: FakeJiraClientOptions = {}): FakeJiraClient => {
  const searches: FakeJiraSearch[] = []
  const posted: FakeJiraCommentPost[] = []
  const commentReads: string[] = []
  const issues = options.issues ?? []
  const comments = new Map<string, JiraCommentRecord[]>(
    Object.entries(options.comments ?? {}).map(([key, value]) => [key, [...value]]),
  )
  const behaviour = options.addCommentBehaviour ?? 'succeed'
  let currentUserCalls = 0
  let nextCommentId = 1000

  const append = (issueKey: string, body: string): JiraCommentRecord => {
    nextCommentId += 1
    const record: JiraCommentRecord = {
      id: `fake-${String(nextCommentId)}`,
      author: options.commentAuthor ?? options.currentUser,
      body,
      created: new Date(0).toISOString(),
    }
    comments.set(issueKey, [...(comments.get(issueKey) ?? []), record])
    return record
  }

  return {
    searches,
    posted,
    commentReads,
    currentUserCalls: () => currentUserCalls,
    commentsOn: (issueKey) => comments.get(issueKey) ?? [],

    currentUser: () => {
      currentUserCalls += 1
      if (options.currentUserError) {
        return Promise.reject(options.currentUserError)
      }
      return Promise.resolve(options.currentUser ?? {})
    },

    searchIssues: (input) => {
      searches.push(input)
      if (options.searchError) {
        return Promise.reject(options.searchError)
      }
      const size = Math.max(input.maxResults, PAGE_FLOOR)
      const page: JiraSearchPage = {
        issues: issues.slice(input.startAt, input.startAt + size),
        startAt: input.startAt,
        maxResults: size,
        total: issues.length,
      }
      return Promise.resolve(page)
    },

    listComments: (input) => {
      commentReads.push(input.issueKey)
      if (options.listCommentsError) {
        return Promise.reject(options.listCommentsError)
      }
      const all = comments.get(input.issueKey) ?? []
      const size = Math.max(input.maxResults, PAGE_FLOOR)
      const page: JiraCommentPage = {
        comments: all.slice(input.startAt, input.startAt + size),
        startAt: input.startAt,
        maxResults: size,
        total: all.length,
      }
      return Promise.resolve(page)
    },

    addComment: (input) => {
      if (behaviour === 'throw') {
        return Promise.reject(new Error('jira rejected the comment'))
      }

      posted.push(input)
      const record = append(input.issueKey, input.body)

      if (behaviour === 'land-then-throw') {
        return Promise.reject(new Error('socket hang up'))
      }

      return Promise.resolve(record)
    },
  }
}
