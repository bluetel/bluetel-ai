import type { ComputeProvisioner } from '../../aws'

/**
 * The ephemeral login environment — provisioning one, finding one, and destroying one
 * (T074, FR-069, FR-071).
 *
 * ## What this module is, in one sentence
 *
 * It turns "an administrator wants to log a seat in" into a tagged EC2 instance that carries the
 * agent CLI and nothing else, and turns the wall-clock deadline that instance was launched with
 * back into something the reaper and the panel can read.
 *
 * ## The environment is the record, and there is no second one
 *
 * There is no `credential_login_sessions` table, and its absence is a design decision rather than
 * an omission. A login attempt is completely described by the instance it runs on: which seat it is
 * for, when it started, and when it stops being allowed to exist. All three are written onto the
 * instance as tags at launch, and {@link listLoginEnvironments} reads them back.
 *
 * A database row alongside would be a second register of the same fact, and the two can disagree —
 * which is precisely the failure mode that matters here. A row saying "no login in progress" beside
 * a running instance is a billable box nobody sweeps; a row saying "login in progress" beside an
 * instance EC2 has already terminated is a seat an administrator cannot retry. With one register
 * there is nothing to reconcile, and "the environment is gone" and "the attempt is over" are the
 * same statement rather than two that have to be kept in step. It is the same argument
 * `jobs/reconcile.ts` makes about workflow instances, applied to a population that has no lease to
 * anchor it.
 *
 * The cost is that a login attempt leaves no history of its own. That is paid for elsewhere: the
 * attempt is on the configuration audit trail when it starts (FR-004), and its outcome is on the
 * credential — `last_login_at` on success, `last_failure_reason` on failure or abandonment (FR-009).
 *
 * ## The boot script carries no envelope, and that is FR-069
 *
 * {@link loginUserData} assembles a script with no job, no workspace, no setup bundle and no
 * workflow-scoped credential. There is nothing on this instance for an interactive administrator to
 * be sitting next to — no client repository, no client credentials, nothing another run put there.
 * What it does carry is the agent CLI, which the executor AMI already has, and a directory for the
 * agent to write its credential into once the login succeeds. `capture.ts` reads that path.
 */

/** Where the agent writes its credential once the administrator has completed the login. */
export const LOGIN_MATERIAL_PATH = '/var/lib/sisyphus/login/credential'

/** The instance type a login environment runs on. Small: it runs a CLI and a terminal. */
export const LOGIN_INSTANCE_TYPE = 't4g.small'

/**
 * How long an environment may exist before the reaper takes it, by default.
 *
 * Fifteen minutes against SC-001's five, deliberately. SC-001 measures the *expected* flow; this
 * bounds the *pathological* one, and a limit that tightly bracketed the happy path would reap a
 * login somebody was ten seconds from finishing. It is long enough that reaping is evidence of
 * abandonment rather than of slowness, and short enough that an abandoned instance is a rounding
 * error rather than a bill.
 */
export const DEFAULT_LOGIN_TTL_MS = 15 * 60_000

/** One live login environment, as this application talks about it. */
export interface LoginEnvironmentRecord {
  readonly agentCredentialId: string
  readonly environmentId: string
  readonly startedAt: Date
  readonly expiresAt: Date
}

export interface ProvisionLoginEnvironmentOptions {
  readonly compute: ComputeProvisioner
  readonly agentCredentialId: string
  readonly credentialName: string
  /** Defaults to {@link DEFAULT_LOGIN_TTL_MS}. Supplied by the deployment, not read here. */
  readonly ttlMs?: number
  /** Injectable clock, so the deadline is testable without waiting for it. */
  readonly now?: Date
}

/**
 * The boot script for a bundle-less, workspace-less login instance (FR-069).
 *
 * Deliberately tiny and deliberately not an envelope. `jobs/job-envelope.ts` assembles what a
 * *workflow* instance needs — a job, a workspace, a bundle, a scoped credential — and none of it
 * applies: there is no run, so there is nothing to scope a credential to, and no work, so there is
 * nothing to check out. Reusing that assembler with most fields blank would produce an instance
 * that merely *happened* to have no workspace this time, rather than one that cannot have one.
 *
 * The seat's name goes in as a comment so a person who has attached to the instance can tell which
 * login they are looking at. It is a name an administrator chose, never material.
 */
export const loginUserData = (input: {
  readonly agentCredentialId: string
  readonly credentialName: string
}): string =>
  [
    '#!/bin/sh',
    'set -eu',
    `# sisyphus agent credential login: ${input.credentialName} (${input.agentCredentialId})`,
    // Nothing is fetched and nothing is mounted. The words this script must not contain are
    // asserted in `environment.test.ts`, so even a comment naming them would fail — which is the
    // point: what makes this environment isolated is that there is nothing here at all.
    '# The agent CLI, and a place for it to write what the login produces.',
    `mkdir -p "$(dirname ${LOGIN_MATERIAL_PATH})"`,
    `chmod 700 "$(dirname ${LOGIN_MATERIAL_PATH})"`,
    '',
  ].join('\n')

/**
 * Launch an environment for one seat (FR-069).
 *
 * The deadline is computed here and written onto the instance by the compute seam, rather than kept
 * in this process. A process holding the only copy of a deadline is a process whose replacement
 * leaks every environment it started — and being replaced is ordinary, not exceptional.
 *
 * @param options - The seam, the seat, and optionally the lifetime and the clock.
 * @returns The environment as the panel and the reaper both see it.
 */
export const provisionLoginEnvironment = async (
  options: ProvisionLoginEnvironmentOptions,
): Promise<LoginEnvironmentRecord> => {
  const startedAt = options.now ?? new Date()
  const expiresAt = new Date(startedAt.getTime() + (options.ttlMs ?? DEFAULT_LOGIN_TTL_MS))

  const launched = await options.compute.launchLogin({
    agentCredentialId: options.agentCredentialId,
    instanceType: LOGIN_INSTANCE_TYPE,
    expiresAt,
    userData: loginUserData({
      agentCredentialId: options.agentCredentialId,
      credentialName: options.credentialName,
    }),
  })

  return {
    agentCredentialId: launched.agentCredentialId,
    environmentId: launched.instanceId,
    startedAt,
    expiresAt,
  }
}

/**
 * Destroy an environment. Idempotent, because every caller may be the second one to try.
 *
 * Three different things destroy an environment — a successful capture, a failed attempt, and the
 * wall-clock reaper — and FR-071 requires all three to. Two of them racing is normal rather than a
 * defect: a capture that lands a second before the deadline is exactly the interesting case, and it
 * must not turn into an error for either party.
 */
export const destroyLoginEnvironment = async (options: {
  readonly compute: ComputeProvisioner
  readonly environmentId: string
}): Promise<void> => {
  await options.compute.terminate({ instanceId: options.environmentId })
}

/**
 * Every live environment, including ones this process never started.
 *
 * **An instance whose tags cannot be read is reported with no deadline**, and the reaper treats
 * that as expired. That is the safe direction and the reason this function does not simply drop
 * such instances: dropping them would make an unaccountable interactive box invisible to the only
 * sweep that would ever have found it. An instance carrying no seat id is dropped, though, because
 * there is no credential to attribute it to and the reaper's other half — writing the reason
 * against the seat — has nothing to write to. Such an instance is still terminated: see
 * {@link listUnattributedLoginEnvironments}.
 */
export const listLoginEnvironments = async (options: {
  readonly compute: ComputeProvisioner
  /** Used only for instances whose deadline tag is missing or unreadable. */
  readonly now?: Date
  /** The lifetime deadlines were computed from, so a start instant can be derived from one. */
  readonly ttlMs?: number
}): Promise<readonly LoginEnvironmentRecord[]> => {
  const now = options.now ?? new Date()
  const ttlMs = options.ttlMs ?? DEFAULT_LOGIN_TTL_MS

  return (await options.compute.listLoginInstances()).flatMap((instance) => {
    if (instance.agentCredentialId === undefined || instance.agentCredentialId === '') {
      return []
    }

    // No readable deadline means immediately expired. An interactive instance the platform cannot
    // date is one nobody is accounting for, and the safe reading of that is that it should go.
    const expiresAt = instance.expiresAt ?? now

    return [
      {
        agentCredentialId: instance.agentCredentialId,
        environmentId: instance.instanceId,
        // **Derived, not recorded.** The launch wrote the deadline and nothing else, because the
        // deadline is the only value any decision is ever made on; the start instant exists so a
        // panel can say "running for four minutes" and is reconstructed from it. A deployment that
        // changed its TTL between the launch and this call would show a slightly wrong elapsed
        // time on the environments already running, and nothing else would differ.
        startedAt: new Date(expiresAt.getTime() - ttlMs),
        expiresAt,
      },
    ]
  })
}

/**
 * Login instances carrying no seat id — the ones {@link listLoginEnvironments} cannot attribute.
 *
 * Separated rather than merged because the two need different treatment and merging them would
 * force one of the two to be wrong. An attributable environment is reaped *and* explained; an
 * unattributable one can only be reaped, because there is no seat to explain it against. Both are
 * destroyed, which is the half that matters for the bill.
 */
export const listUnattributedLoginEnvironments = async (options: {
  readonly compute: ComputeProvisioner
}): Promise<readonly string[]> =>
  (await options.compute.listLoginInstances()).flatMap((instance) =>
    instance.agentCredentialId === undefined || instance.agentCredentialId === ''
      ? [instance.instanceId]
      : [],
  )
