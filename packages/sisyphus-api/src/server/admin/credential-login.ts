import { eq } from 'drizzle-orm'

import type { SisyphusDatabase } from '../../db'
import { agentCredentials } from '../../db'

/**
 * The hosted login environment, as this package is allowed to see it — a seam, not an EC2 client
 * (FR-069, FR-070, FR-071, FR-072).
 *
 * ## Why there is a port here at all
 *
 * The same reason `machine/credential-material.ts` and `admin/reachability.ts` have one: the
 * environment is provisioned from
 * `apps/sisyphus-control-plane/src/credentials/login/`, and this package cannot import an
 * application without inverting the dependency graph and becoming impossible to build in two of its
 * three consumption modes. So the panel's administrative surface states what it needs — start one, find
 * one, list them, destroy one — and whichever host is running supplies it.
 *
 * ## What a holder of this port deliberately cannot do
 *
 * **It cannot read credential material, and there is nowhere in these types to put any.** Not one
 * field on {@link LoginEnvironment}, {@link LoginRelay} or {@link StartedLogin} carries a value: an
 * instance id, two timestamps, and the three fields AWS needs in order to open a terminal. That is
 * FR-070 expressed as a type rather than as a rule — the resulting material is read **on the
 * instance** and written to the secret store server-side by the control plane's `capture.ts`, and
 * nothing on the path between the login environment and the administrator's browser is capable of
 * carrying it.
 *
 * The relay's `streamUrl` and `tokenValue` do reach the browser, and they are not an exception.
 * They are a short-lived SSM session handle — the credential for a *terminal*, issued by AWS to the
 * platform's own role, and worth exactly one interactive session on one instance that holds no
 * workspace, no bundle and nobody else's material. The agent credential the administrator is
 * creating never travels that way; it is written by the agent into a file on the instance, read
 * from there by the platform, and put in Secrets Manager. `credentials.test.ts` asserts the
 * property directly, by scanning every value the login procedures answer with for the material the
 * store holds.
 *
 * ## Why the reap lives in this package rather than beside the job that schedules it
 *
 * {@link reapAbandonedLogins} writes `agent_credentials.last_failure_reason` and calls
 * {@link AgentCredentialLoginEnvironments.destroy}. Both halves belong here — the table is this
 * package's, and the port is declared three screens up — and the control plane's
 * `credentials/login/reaper.ts` is the scheduled *job* that supplies the clock, the port built over
 * the real EC2 seam, and the outcome wrapper every other job in that application has.
 *
 * The alternative was to write the sweep twice, once for the panel and once for the schedule. That
 * is how a reaper acquires two definitions of "expired" and the abandoned case ends up covered by
 * whichever of them is not running.
 */

/**
 * The handle an administrator's browser opens a terminal with.
 *
 * Three fields, because three is what `ssm:StartSession` answers with and what the AWS session
 * client needs. Nothing is derived here and nothing is added: a port that composed a URL would be
 * making a decision about a protocol it does not own.
 */
export interface LoginRelay {
  readonly sessionId: string
  readonly streamUrl: string
  readonly tokenValue: string
}

/**
 * One live login environment.
 *
 * `expiresAt` is a **wall-clock deadline fixed when the environment is created**, not a sliding
 * window that activity extends. That is the whole of FR-071's abandonment case: an administrator
 * who closes the tab produces no event of any kind, so anything that waited to be told the attempt
 * was over would wait forever. The deadline is a fact about the instance, and the reaper compares
 * it against the clock.
 */
export interface LoginEnvironment {
  readonly agentCredentialId: string
  /** The instance the login runs on, as the compute seam names it. */
  readonly environmentId: string
  readonly startedAt: Date
  readonly expiresAt: Date
}

/** What starting a login answers with: the environment, and the one relay handle issued for it. */
export interface StartedLogin {
  readonly environment: LoginEnvironment
  readonly relay: LoginRelay
}

/**
 * The seam. Four methods, and no way to read or write material — see the module note.
 *
 * `find` and `list` are separate because they answer different questions with different costs.
 * `find` is what the panel asks while an administrator watches one seat; `list` is what the reaper
 * walks, and it must return environments **this process never started**, because the process that
 * started them may have been replaced. A `find`-only port would make the abandoned case
 * unreachable, which is the case the whole reaper exists for.
 */
export interface AgentCredentialLoginEnvironments {
  /**
   * Provision an environment for this seat and open a relayed session into it.
   *
   * @throws When no environment could be provisioned. The caller records the reason against the
   *   credential (FR-009) rather than letting it escape as a bare 500.
   */
  readonly start: (input: {
    readonly agentCredentialId: string
    /** For the instance's `Name` tag, so a login is identifiable in the console without a lookup. */
    readonly credentialName: string
  }) => Promise<StartedLogin>
  /** The live environment for one seat, or `undefined` when there is none. */
  readonly find: (agentCredentialId: string) => Promise<LoginEnvironment | undefined>
  /** Every live environment, including ones this process did not start. */
  readonly list: () => Promise<readonly LoginEnvironment[]>
  /** Destroy one. Idempotent: destroying an environment that is already gone is not an error. */
  readonly destroy: (input: { readonly environmentId: string }) => Promise<void>
}

/** The reason given when a deployment has wired no login environment provisioner. */
export const LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON =
  'this deployment has no agent credential login environment configured, so a login cannot be started'

/**
 * The provisioner used when a deployment has wired none.
 *
 * `start` **refuses**, for the reason `createRefusingReachabilityProbe` refuses: a login that appeared to
 * begin and provisioned nothing would leave an administrator waiting at a terminal that will never
 * open, and the credential would sit in `awaiting_login` with no explanation against it.
 *
 * `list` answers empty and `destroy` succeeds, and that asymmetry is deliberate rather than lax. A
 * deployment with no provisioner has no environments, so "none exist" is the true answer and not a
 * guess — and a reaper that threw here would turn a deployment with nothing wired into a job that fails
 * on every schedule while having nothing whatever to do.
 */
export const createRefusingLoginEnvironments = (): AgentCredentialLoginEnvironments => ({
  start: () => Promise.reject(new Error(LOGIN_ENVIRONMENT_NOT_CONFIGURED_REASON)),
  find: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  destroy: () => Promise.resolve(),
})

/**
 * What is written against a seat whose login environment was reaped (FR-009, FR-071).
 *
 * Rendered to administrators **verbatim**, so it says what happened, what it cost them and what to
 * do next — and it names no identifier a person cannot act on. It carries no material, which is a
 * property of this constant rather than of care taken at the call site: the reaper never sees any.
 */
export const ABANDONED_LOGIN_REASON =
  'The login environment was destroyed because the attempt ran past its time limit without material being captured. Nothing was recorded against this credential. Start the login again — the whole flow is meant to take a few minutes, and the environment is not kept alive between attempts.'

/** One environment the sweep destroyed. Carries identifiers and instants, and nothing else. */
export interface ReapedLogin {
  readonly environmentId: string
  readonly agentCredentialId: string
  readonly expiresAt: Date
  /** Whether a reason was written against the credential — false when the row no longer exists. */
  readonly reasonRecorded: boolean
}

export interface ReapAbandonedLoginsOptions {
  readonly db: SisyphusDatabase
  readonly environments: AgentCredentialLoginEnvironments
  /** Injectable clock, so the deadline can be crossed in a test without waiting for it. */
  readonly now?: Date
}

export interface ReapAbandonedLoginsResult {
  /** How many live environments were considered, expired or not. */
  readonly considered: number
  readonly reaped: readonly ReapedLogin[]
}

/**
 * Destroy every login environment whose deadline has passed (FR-071).
 *
 * **This is a wall-clock sweep and consults no event of any kind.** It does not ask whether a
 * session is still open, whether a browser is still polling, or whether material has been captured.
 * That is not an oversight: the case it exists for produces no event at all. An administrator who
 * closes the tab has told the platform nothing, and every design that waits to be told leaves a
 * billable interactive instance running, holding a half-finished login, until a human happens to
 * look at the account.
 *
 * A successful capture destroys its own environment immediately (see the control plane's
 * `capture.ts`), so in the ordinary case this sweep finds nothing. It is the backstop, and the
 * backstop is the part that has to work when nothing else did.
 *
 * The **environment is destroyed before the reason is written**, and the order matters: the write
 * is bookkeeping an administrator reads later, while the instance is the thing costing money and
 * holding a session. If the write fails, the sweep has still stopped the bill.
 *
 * @param options - The handle, the environments port and optionally the clock.
 * @returns What was considered and what was destroyed. No material, because none is ever in reach.
 */
export const reapAbandonedLogins = async (
  options: ReapAbandonedLoginsOptions,
): Promise<ReapAbandonedLoginsResult> => {
  const { db, environments } = options
  const now = options.now ?? new Date()

  const live = await environments.list()
  const reaped: ReapedLogin[] = []

  for (const environment of live) {
    if (environment.expiresAt.getTime() > now.getTime()) {
      continue
    }

    await environments.destroy({ environmentId: environment.environmentId })

    const updated = await db
      .update(agentCredentials)
      .set({ lastFailureReason: ABANDONED_LOGIN_REASON, updatedAt: now })
      .where(eq(agentCredentials.id, environment.agentCredentialId))
      .returning({ id: agentCredentials.id })

    reaped.push({
      environmentId: environment.environmentId,
      agentCredentialId: environment.agentCredentialId,
      expiresAt: environment.expiresAt,
      reasonRecorded: updated.length > 0,
    })
  }

  return { considered: live.length, reaped }
}
