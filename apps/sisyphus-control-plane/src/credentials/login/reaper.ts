import type { SisyphusDatabase } from '@bluetel-ai/sisyphus-api/db'
import type {
  AgentCredentialLoginEnvironments,
  ReapAbandonedLoginsResult,
} from '@bluetel-ai/sisyphus-api/server'
import { reapAbandonedLogins } from '@bluetel-ai/sisyphus-api/server'

import type { ComputeProvisioner } from '../../aws'

import {
  destroyLoginEnvironment,
  listLoginEnvironments,
  listUnattributedLoginEnvironments,
} from './environment'

/**
 * The wall-clock reaper (T077, FR-071).
 *
 * ## What it is for, said plainly
 *
 * An administrator starts a login and closes the tab. From the platform's side **nothing happens**:
 * there is no disconnect to observe, no failure to record, no completion to miss. An interactive
 * EC2 instance is left running, holding a half-finished login, and the only thing that changes from
 * that moment on is the clock.
 *
 * So this job is driven by the clock and by nothing else. It does not ask whether a session is
 * still attached, whether the panel is still polling, or whether material has appeared. Every one
 * of those questions has a perfectly healthy answer during a normal login and no answer at all
 * during an abandoned one, which is precisely why none of them is asked.
 *
 * A successful capture destroys its own environment, and so does a failed attempt (FR-071 requires
 * all three), so in the ordinary case this sweep finds nothing to do. It is the backstop, and the
 * backstop is the part that has to work when nothing else did.
 *
 * ## Why the decision lives in the API package and the schedule lives here
 *
 * {@link reapAbandonedLogins} writes `agent_credentials.last_failure_reason` and calls the login
 * environments port. The table and the port both belong to `@bluetel-ai/sisyphus-api`, and the
 * panel's own suite exercises the same function — which is what stops the abandoned case having two
 * definitions of "expired", one of them in whichever half is not running.
 *
 * What is here is everything that is genuinely this application's: the compute seam, the clock, the
 * job name, and the population the API package's port cannot describe — see below.
 *
 * ## Unattributable instances are destroyed and not explained
 *
 * A login instance whose credential tag is missing or empty cannot be reaped through the port,
 * because the port's sweep writes a reason against a seat and there is no seat to write to. It is
 * still terminated, by {@link reapLoginEnvironments} directly. An interactive instance the platform
 * cannot attribute is one nobody is accounting for, and leaving it running because the bookkeeping
 * half has nothing to say would be letting the cheaper half of the job veto the expensive one.
 */

/** The job's name, as `runJob` and the schedule both spell it. */
export const REAP_LOGIN_ENVIRONMENTS_JOB_NAME = 'reap-login-environments'

export interface ReapLoginEnvironmentsOptions {
  readonly db: SisyphusDatabase
  readonly compute: ComputeProvisioner
  /** The lifetime deadlines were computed from, so a start instant can be derived from one. */
  readonly ttlMs?: number
  /** Injectable clock, so a deadline can be crossed in a test without waiting for it. */
  readonly now?: Date
}

export interface ReapLoginEnvironmentsResult extends ReapAbandonedLoginsResult {
  /** Instances terminated without a seat to record a reason against. */
  readonly unattributed: readonly string[]
}

/**
 * Build the port {@link reapAbandonedLogins} sweeps, over this application's compute seam.
 *
 * Only the three methods the sweep uses are real. `start` rejects, and deliberately: this object
 * exists to destroy environments, and a reaper that could create one would be an odd thing to hand
 * a schedule. The composition root builds the full provisioner, relay and all.
 */
export const reapingEnvironments = (options: {
  readonly compute: ComputeProvisioner
  readonly ttlMs?: number
  readonly now?: Date
}): AgentCredentialLoginEnvironments => ({
  start: () =>
    Promise.reject(
      new Error('The login reaper destroys environments and does not provision them.'),
    ),
  find: async (agentCredentialId) =>
    (await listLoginEnvironments(options)).find(
      (environment) => environment.agentCredentialId === agentCredentialId,
    ),
  list: () => listLoginEnvironments(options),
  destroy: (input) =>
    destroyLoginEnvironment({ compute: options.compute, environmentId: input.environmentId }),
})

/**
 * Destroy every login environment past its deadline, and every one that cannot be attributed.
 *
 * @param options - The handle, the compute seam and optionally the lifetime and the clock.
 * @returns What was considered, what was reaped with a reason recorded, and what was terminated
 *   without one. No material, because none is ever in reach of this job.
 */
export const reapLoginEnvironments = async (
  options: ReapLoginEnvironmentsOptions,
): Promise<ReapLoginEnvironmentsResult> => {
  const { compute, db } = options

  const swept = await reapAbandonedLogins({
    db,
    environments: reapingEnvironments({ compute, ttlMs: options.ttlMs, now: options.now }),
    now: options.now,
  })

  // Second, and unconditionally: an instance with no seat id has no deadline anybody wrote and no
  // seat to explain it against, so age is not even a question. It should not be there at all.
  const unattributed = await listUnattributedLoginEnvironments({ compute })
  for (const environmentId of unattributed) {
    await destroyLoginEnvironment({ compute, environmentId })
  }

  return { ...swept, unattributed }
}
