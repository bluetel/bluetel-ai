import type { SisyphusDatabase } from '../db'
import type { UserRole } from '../enums'

import type { RepositoryReachabilityProbe } from './admin/reachability'
import { memoiseAsync } from './memoise'
import type { WorkflowEventEmitter } from './notify'
import type { ScopeResolver } from './scope'
import { createScopeResolver, createUnauthenticatedScopeResolver } from './scope'
import type { TRPCContextOptions } from './trpc'

/**
 * The Sisyphus request context — what every procedure is handed, and nothing more.
 *
 * Two things are established here rather than in resolvers: **who is calling** and **what they
 * may see**. Both are awaited, which is why the context hook is async (see `trpc.ts`). Anything a
 * resolver would otherwise have to work out for itself — the caller's grants, the executor's
 * workflow id — is a silent-leak risk under FR-190 and belongs on this object instead.
 */

/** The signed-in human behind an interactive request. */
export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: UserRole
  /**
   * Deactivation is not deletion (FR-176). Sessions are database-backed so a deactivated user
   * fails at the **next request** rather than at next sign-in (FR-175), which is why this flag is
   * carried on the session and re-checked per request.
   */
  readonly isActive: boolean
}

/** A resolved, unexpired human session. */
export interface SisyphusSession {
  readonly user: SessionUser
  readonly expiresAt: Date
}

/**
 * The workflow-scoped credential an executor instance presents on the machine surface.
 *
 * It authorises writes about **one** workflow and nothing on the interactive surface (FR-005).
 * `jti` is unique per issue so a replayed token is recognisable rather than merely unexpired
 * (FR-037).
 */
export interface MachineCredential {
  readonly credentialId: string
  readonly workflowId: string
  readonly jti: string
  readonly expiresAt: Date
}

/** Why a request was refused, recorded for the audit trail (FR-169, FR-180, FR-018). */
export interface AuthorisationDenial {
  readonly reason:
    | 'not_signed_in'
    | 'inactive_user'
    | 'not_admin'
    | 'machine_credential_missing'
    | 'machine_credential_invalid'
    | 'surface_confusion'
    | 'cross_workflow_write'
    /**
     * An authenticated, active, non-admin caller reached for an execution profile they hold no
     * live grant on (FR-180). Distinct from `not_admin`: the caller's role is not the problem, so
     * recording it as one would make the trail say something untrue. The *refusal* is still
     * `NOT_FOUND` with the same message a nonexistent profile gets — FR-190 forbids the response
     * confirming the profile exists. Only the recorded event knows the difference.
     */
    | 'profile_not_granted'
  readonly userId?: string
  readonly workflowId?: string
  readonly path?: string
  readonly detail?: string
}

/**
 * Everything the context needs from the host application.
 *
 * Injected per request rather than imported, because this package must not read the environment:
 * the panel, the control plane and the tests each build a handle their own way, and a
 * module-level singleton captured at import time would make the package unusable from two of the
 * three consumption modes.
 */
export interface SisyphusDependencies {
  readonly db: SisyphusDatabase
  /** Resolves the human session, or `null` for an unauthenticated or machine-surface request. */
  readonly resolveSession: (headers: Headers) => Promise<SisyphusSession | null>
  /** Verifies a workflow-scoped credential, or `null` when the request carries none. */
  readonly resolveMachineCredential: (headers: Headers) => Promise<MachineCredential | null>
  /** Records a refusal. Failures here must not mask the refusal itself. */
  readonly recordDenial: (denial: AuthorisationDenial) => Promise<void>
  /**
   * The outbound half of FR-124's profile-enable gate: can this deployment's credential reach a
   * repository and its base branch?
   *
   * Optional, and a deployment that omits it gets a probe that **refuses** every enable rather
   * than one that waves them through — an unchecked gate is worse than an absent one, because it
   * reports a check that did not happen. See `server/admin/reachability.ts`.
   */
  readonly repositoryReachability?: RepositoryReachabilityProbe
  /**
   * Where FR-136's notifications go — a port, not a Slack client (FR-140, FR-141).
   *
   * Four of FR-136's events plus `review_iteration_failed` are set on the machine surface in this
   * package rather than by a control-plane job, so they need a way out of here that does not make
   * this package depend on an app. This is that seam; see `server/notify/emitter.ts` for why it is
   * a port and what a holder of one deliberately cannot do.
   *
   * Optional, and unlike {@link SisyphusDependencies.repositoryReachability} an omitted notifier is
   * a **silent no-op** rather than a refusal. The asymmetry is deliberate: an unwired gate reports
   * a check that did not happen, whereas an unwired notifier withholds a message and breaks
   * nothing — and FR-140 already requires that an unnotifiable recipient never fails a run.
   */
  readonly notifier?: WorkflowEventEmitter
}

/** The request-scoped values added on top of `{ headers, dependencies }`. */
export interface SisyphusAdditionalContext {
  readonly db: SisyphusDatabase
  readonly session: SisyphusSession | null
  /**
   * The caller's visible set, **unresolved**. Awaiting it costs a `profile_access_grants` query,
   * which the health check and every machine call would otherwise pay for and never read
   * (FR-190).
   */
  readonly scope: ScopeResolver
  /**
   * The executor credential, **unresolved**, for the same reason. Verifying one costs a lookup
   * that no interactive request needs.
   */
  readonly machineCredential: () => Promise<MachineCredential | null>
}

/** The full context object a procedure receives. */
export type SisyphusContext = TRPCContextOptions<SisyphusDependencies> & SisyphusAdditionalContext

/**
 * Build the request-scoped context.
 *
 * The session is awaited eagerly and the other two are not, and the asymmetry is deliberate:
 * almost every interactive procedure needs the session, whereas a request with no session cookie
 * resolves to `null` without touching the database — so the machine surface pays nothing for it.
 * The grants query and the credential verification are the expensive lookups, and both stay lazy.
 */
export const createSisyphusAdditionalContext = async ({
  headers,
  dependencies,
}: TRPCContextOptions<SisyphusDependencies>): Promise<SisyphusAdditionalContext> => {
  const session = await dependencies.resolveSession(headers)

  return {
    db: dependencies.db,
    session,
    scope:
      session === null
        ? createUnauthenticatedScopeResolver()
        : createScopeResolver({
            db: dependencies.db,
            identity: { userId: session.user.id, isAdmin: session.user.role === 'admin' },
          }),
    machineCredential: memoiseAsync(() => dependencies.resolveMachineCredential(headers)),
  }
}
