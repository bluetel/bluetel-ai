import type { ResolvedScope, ScopeIdentity, SisyphusSession } from '@bluetel-ai/sisyphus-api/server'

/**
 * Who may open a log stream, and what everyone else is told (FR-190, FR-175).
 *
 * ## A stream is a read, and reads are scoped
 *
 * `logStream` is an SSE route rather than a tRPC procedure, so it does not inherit
 * `scopedProcedure`'s middleware and has to reach the same answer itself. Skipping the check
 * because "it is only logs" would be a disclosure with a different content type: the log of a run
 * outside the caller's scope is the run's output, and the mere fact that a stream opens confirms
 * the workflow exists.
 *
 * The decision is a pure function of the session and one injected lookup so it can be tested
 * without a database and without a request, which is the part most easily got wrong.
 *
 * ## What an out-of-scope caller sees
 *
 * Exactly what a caller asking for a workflow that does not exist sees: `404` with the body
 * `Workflow not found.` and no `Content-Type: text/event-stream`. Same status, same message, same
 * headers, no timing branch that reaches further for one than the other — the two cases are
 * decided by the same query, so there is nothing to tell apart. `403` would answer "does this
 * workflow exist?" with yes.
 *
 * A caller with no session at all gets `401`, mirroring `authedProcedure` exactly. That discloses
 * nothing: a signed-out caller learns only that the panel wants a session, which the sign-in page
 * already tells them.
 */

/** The minimum a stream needs to know about the run it is following. */
export interface StreamWorkflow {
  readonly id: string
  readonly state: string
}

export type LogStreamAccess =
  | {
      readonly outcome: 'granted'
      readonly workflow: StreamWorkflow
      readonly identity: ScopeIdentity
    }
  /** No session. `401`, and not recorded — a signed-out browser is ordinary traffic. */
  | { readonly outcome: 'unauthenticated' }
  /** A session whose account was deactivated. `401`, and recorded (FR-175). */
  | { readonly outcome: 'inactive'; readonly userId: string }
  /** Out of scope, or absent. `404`, indistinguishably (FR-190). */
  | { readonly outcome: 'not-found' }

export interface LogStreamAccessOptions {
  readonly session: SisyphusSession | null
  /** As it arrived in the path — untrusted, and possibly not a workflow id at all. */
  readonly workflowId: string | undefined
  /** Reads the workflow **through the caller's scope**, answering `undefined` for both cases. */
  readonly findWorkflowInScope: (
    identity: ScopeIdentity,
    workflowId: string,
  ) => Promise<StreamWorkflow | undefined>
}

/** The identity a resolved session presents to the scope. */
export const identityFor = (session: SisyphusSession): ScopeIdentity => ({
  userId: session.user.id,
  isAdmin: session.user.role === 'admin',
})

/**
 * Decide whether this caller may follow this run's output.
 *
 * @param options - The session, the requested id and the scoped lookup.
 */
export const decideLogStreamAccess = async (
  options: LogStreamAccessOptions,
): Promise<LogStreamAccess> => {
  const { session, workflowId } = options

  if (session === null) {
    return { outcome: 'unauthenticated' }
  }

  if (!session.user.isActive) {
    return { outcome: 'inactive', userId: session.user.id }
  }

  if (workflowId === undefined || workflowId === '') {
    // Answered as absent rather than as a bad request, so a malformed id and an unknown one are
    // the same response.
    return { outcome: 'not-found' }
  }

  const identity = identityFor(session)
  const workflow = await options.findWorkflowInScope(identity, workflowId)

  return workflow === undefined
    ? { outcome: 'not-found' }
    : { outcome: 'granted', workflow, identity }
}

const refusal = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      'content-type': 'application/json',
      // A refusal must never be cached: a grant issued a moment later has to take effect at the
      // next attempt, and a cached 404 would outlive it.
      'cache-control': 'no-store',
    },
  })

/**
 * The response for every refusal.
 *
 * One function, so the out-of-scope answer and the nonexistent answer are constructed by the same
 * code and cannot drift into differing by a header.
 *
 * @param access - Any non-granted decision.
 */
export const refusalResponse = (
  access: Exclude<LogStreamAccess, { outcome: 'granted' }>,
): Response => {
  switch (access.outcome) {
    case 'unauthenticated':
      return refusal(401, 'Not signed in.')
    case 'inactive':
      return refusal(401, 'This account is no longer active.')
    case 'not-found':
      return refusal(404, 'Workflow not found.')
  }
}

/**
 * How often an open stream re-asks whether the caller may still see the run.
 *
 * A grant is revoked by a column, and FR-184 says revocation takes effect at the caller's next
 * request. An SSE connection is **one** request that may stay open for the length of a run, so
 * without this a revoked engineer would keep receiving output until the workflow ended. Five
 * seconds is one `profile_access_grants` query per stream per five seconds — negligible beside
 * the four `log_segments` reads a second the transport already performs — and it bounds the
 * exposure to roughly the same window a page navigation would have.
 */
export const SCOPE_REVALIDATION_MS = 5_000

export interface RevalidatingScopeOptions {
  readonly identity: ScopeIdentity
  readonly resolve: (identity: ScopeIdentity) => Promise<ResolvedScope>
  readonly intervalMs?: number
  readonly now?: () => number
}

/**
 * A scope that is re-resolved once its answer is older than {@link SCOPE_REVALIDATION_MS}.
 *
 * The request-scoped resolver `sisyphus-api` builds is memoised **for the whole request**, which
 * is right for an RPC that lasts milliseconds and wrong for a stream that lasts an hour. This
 * wraps it so the memoisation has a lifetime.
 *
 * @param options - The caller's identity and the underlying resolver.
 */
export const createRevalidatingScope = (
  options: RevalidatingScopeOptions,
): { readonly resolve: () => Promise<ResolvedScope> } => {
  const intervalMs = options.intervalMs ?? SCOPE_REVALIDATION_MS
  const now = options.now ?? Date.now
  let cached: { readonly at: number; readonly scope: Promise<ResolvedScope> } | undefined

  return {
    resolve: () => {
      const current = cached
      if (current !== undefined && now() - current.at < intervalMs) {
        return current.scope
      }

      const scope = options.resolve(options.identity)
      cached = { at: now(), scope }
      return scope
    },
  }
}
