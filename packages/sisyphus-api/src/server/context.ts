import type { SisyphusDatabase } from '../db'
import type { UserRole } from '../enums'

import type { AgentCredentialLeaseReleases } from './admin/credential-leases'
import type { AgentCredentialLoginEnvironments } from './admin/credential-login'
import type { AgentCredentialMaterialStore } from './machine/credential-material'
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
   * Where FR-136's notifications go — a port, not a Slack client (FR-140, FR-141).
   *
   * Four of FR-136's events plus `review_iteration_failed` are set on the machine surface in this
   * package rather than by a control-plane job, so they need a way out of here that does not make
   * this package depend on an app. This is that seam; see `server/notify/emitter.ts` for why it is
   * a port and what a holder of one deliberately cannot do.
   *
   * Optional, and an omitted notifier is a **silent no-op** rather than a refusal. That is the
   * right default only because the refusal would be survivable: a withheld message costs a
   * recipient their notification and nothing else, and FR-140 already requires that an
   * unnotifiable recipient never fails a run. A seam on a path where refusing would take the
   * product down does not get the same treatment — it does not get to be optional at all.
   */
  readonly notifier?: WorkflowEventEmitter
  /**
   * Where `admin.credentials.startLogin` provisions the hosted login environment, and what the
   * wall-clock reaper destroys (003/FR-069, 003/FR-070, 003/FR-071, 003/FR-072).
   *
   * The second port on this object, and declared for the same reason as the first: the real
   * environment is provisioned from `apps/sisyphus-control-plane/src/credentials/login/`, and this
   * package must not depend on an application. See `server/admin/credential-login.ts` — chiefly for
   * why a holder of one cannot read credential material, which is the property that keeps FR-070
   * true of the panel's request path rather than merely intended.
   *
   * Optional, and an omitted provisioner **refuses** to start a login rather than behaving like an
   * omitted {@link SisyphusDependencies.notifier} and appearing to start one. A login that
   * provisioned nothing would leave an administrator waiting at a terminal that never opens, with
   * nothing recorded against the seat to say why.
   */
  readonly agentCredentialLogin?: AgentCredentialLoginEnvironments
  /**
   * How the **machine surface** reads the material it hands an instance, and writes the material a
   * rotation brings back (003/FR-012, 003/FR-030, 003/FR-032).
   *
   * The third port, and deliberately a *second* one onto the same store rather than two methods on
   * {@link SisyphusDependencies.agentCredentialSecrets}. That port's whole design is that a holder
   * of it cannot read material, because every administrative procedure holds it; this one can, and
   * is reachable only from `server/machine/`, where the caller is an executor presenting a
   * workflow-scoped credential. See `server/machine/credential-material.ts` for the comparison in
   * full — chiefly for why widening the admin port instead would have destroyed the property that
   * port exists for.
   *
   * Optional, and an omitted store **refuses in both directions** — like
   * {@link SisyphusDependencies.agentCredentialLogin} and unlike
   * {@link SisyphusDependencies.notifier}. An empty read would install a working credential's worth
   * of nothing on a paid instance, and a swallowed write would report a rotation as persisted and
   * lose it, which is the exact failure FR-030 and FR-032 exist to prevent.
   */
  readonly agentCredentialMaterial?: AgentCredentialMaterialStore
  /**
   * How `admin.credentials.forceRelease` takes a seat back from the run holding it (003/FR-057).
   *
   * The fourth port, and declared for the same reason as the other three: releasing a lease is
   * `apps/sisyphus-control-plane/src/credentials/lease/release.ts`, and this package must not
   * depend on an application. A holder of it can end one lease as an attributed administrator and
   * can do nothing else — see `server/admin/credential-leases.ts`, chiefly for why the *other* half
   * of FR-057 (resolving the affected run to a recorded state) deliberately stays in this package.
   *
   * Optional, and an omitted one is refused **before the procedure writes anything**, which is
   * unlike the two other refusing ports. Those refuse at the moment they are called, which is safe
   * because calling them is the whole operation; a force-release is two writes in a fixed order,
   * and a refusal discovered between them would have ended somebody's run without freeing the seat.
   * ({@link SisyphusDependencies.notifier} is the fourth, and refuses at no point at all — an
   * omitted notifier is a silent no-op, for the reason given there.)
   */
  readonly agentCredentialLeases?: AgentCredentialLeaseReleases
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
