/**
 * **Bootstrap phase `credential_install` — the leased seat, put where the agent
 * reads it (003/T055, FR-012, FR-013, FR-014, FR-049, FR-050, FR-051).**
 *
 * One authenticated call to the machine surface, one file written. That is the
 * whole phase, and its shortness is the point: it exists as a phase of its own —
 * individually timed, individually reported — so that a run which cannot get its
 * credential fails saying `credential_install` rather than producing a generic
 * bootstrap failure an administrator has to bisect (FR-049, FR-051).
 *
 * ## Where it sits, and why there
 *
 * After `setup_script`, because the bundle is what puts the agent CLI on the box
 * and there is nothing to configure before it exists. Before `entry_checkout`,
 * because there is no reason to clone a customer's repositories for a run that
 * cannot authenticate. `bootstrap/phases.ts` fixes that position in
 * `BOOTSTRAP_PHASES` and asserts it by index; `run/bootstrap.ts` is the sequence
 * that actually runs it.
 *
 * ## It runs on **every** boot, and that is not an optimisation to remove
 *
 * First boot, restore boot, resumed-instance boot alike (FR-050). It is
 * deliberately unconditional in `run/bootstrap.ts`, with no `resumeFromSnapshot`
 * branch anywhere near it, for two independent reasons:
 *
 * - a snapshot excludes the credential subtree (FR-013), so a restored instance
 *   has no material on its disk at all; and
 * - a **stopped** instance does have material on its disk, and it may be stale —
 *   the credential can have been rotated by something else while this instance
 *   was not running. Reinstalling costs one request; not reinstalling costs a
 *   run that starts, authenticates with a superseded token, and fails somewhere
 *   less legible.
 *
 * ## There is no "no credential available" branch, and its absence is the design
 *
 * This phase can fail on transport — the surface is unreachable, the store could
 * not be read, the file could not be written — and on nothing else. It cannot
 * fail because no seat was free, because **the lease was reserved at admission,
 * before any compute was provisioned** (FR-016). By the time this instance
 * exists to make the call, the claim it is collecting has already been made and
 * has been held for this workflow ever since. A `PRECONDITION_FAILED` from the
 * surface here therefore means a control-plane bug rather than a busy pool, and
 * it is reported as a failed phase rather than retried into: waiting would be
 * waiting for a seat that was never going to be allocated by anything this
 * instance can do.
 *
 * That is also why nothing here queues, backs off past the phase timeout, or
 * degrades to a "run without a credential" mode. A run that cannot authenticate
 * has nothing to do, and FR-051 requires the agent not to be started.
 *
 * ## Material handling
 *
 * The material is registered as a known redaction value **before** it is written
 * (FR-014), so there is no window in which it is on the box and unknown to the
 * output pipeline. Nothing in this module ever puts it into an error message, a
 * log line or a returned value: {@link InstalledAgentCredential} carries the
 * identifiers and the path, and the bytes go from the response straight to the
 * file. It is written inside {@link AGENT_CREDENTIAL_DIR_NAME}, which is the
 * exact subtree `session/snapshot.ts` excludes from every archive (FR-013) —
 * the two derive that path from the same constant so they cannot drift.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SecretRegistry } from '../output'
import { agentCredentialSecret } from '../output'

import { BootstrapPhaseError, runPhase } from './phases'
import type { BootstrapPhaseReporter, RunPhaseContext } from './phases'
import { agentCredentialDir } from './workspace'

/**
 * The file the agent reads its login from, beneath the credential directory.
 *
 * Pinned here rather than discovered, and it is the one thing in this module
 * that is an assumption rather than a guarantee. Research R3 records that the
 * on-disk location and format are platform-specific — on macOS the agent may
 * keep this material in the OS keychain instead — and that reading a real
 * credential file was deliberately not attempted. The executor's target is
 * Linux, where it is a file; this constant is the single place that assumption
 * is written down, so confirming or correcting it against a real instance is a
 * one-line change rather than a search.
 */
export const AGENT_CREDENTIAL_FILE_NAME = '.credentials.json'

/** Owner-only. The instance runs the agent and a customer's `setup.sh` alike. */
const CREDENTIAL_DIR_MODE = 0o700
const CREDENTIAL_FILE_MODE = 0o600

/**
 * Where the material lands, and the one path the rotation watcher watches.
 *
 * @param workspaceRoot - The pinned root (FR-051).
 */
export const agentCredentialPath = (workspaceRoot: string): string =>
  join(agentCredentialDir(workspaceRoot), AGENT_CREDENTIAL_FILE_NAME)

/**
 * What `machine.fetchAgentCredential` answers with.
 *
 * Restated structurally rather than imported from the API package's router
 * types, for the reason `job-envelope.ts` gives at length: the executor's only
 * edge to that package is `import type` from `/client`, and this module is
 * reached from a bootstrap sequence that must stay free of any value import
 * which could pull a resolver into the bundle. `report/client.ts` is where the
 * router-derived types live, and its implementation satisfies this shape
 * structurally — so the two cannot drift without failing to compile at the call
 * site.
 */
export interface FetchedAgentCredential {
  readonly credentialId: string
  /**
   * The credential's fence **at the moment of the fetch**, which is what a
   * rotation must present back (FR-020). Not necessarily the `leaseFence` the
   * envelope carried: where they differ, this instance has already lost its
   * claim, and the difference is only discoverable by presenting this value.
   */
  readonly fence: number
  readonly material: string
}

/** The one call this phase makes. */
export interface AgentCredentialSource {
  readonly fetchAgentCredential: () => Promise<FetchedAgentCredential>
}

export interface InstallAgentCredentialOptions {
  readonly source: AgentCredentialSource
  /** The pinned root (FR-051). The material lands beneath its config tree. */
  readonly workspaceRoot: string
  readonly reporter: BootstrapPhaseReporter
  /**
   * The run's known-value redaction set (FR-014).
   *
   * Not optional in practice and not defaulted here either: a caller that
   * forgot it would install material the output pipeline had never heard of,
   * and the omission would be invisible until something echoed it. Making it a
   * required option is the cheapest way to make forgetting it a compile error.
   */
  readonly secrets: SecretRegistry
  /** Overrides `DEFAULT_PHASE_TIMEOUTS.credential_install` for this phase. */
  readonly timeoutMs?: number
  /** Injected in tests so a duration is measured rather than slept through. */
  readonly now?: () => number
}

/**
 * What the phase produces. **Identifiers and a path — never the material.**
 *
 * The fence travels on to `credential/rotation-watch.ts`, which cannot report a
 * rotation without one, and the id is what a phase report and a log line name.
 */
export interface InstalledAgentCredential {
  readonly credentialId: string
  readonly fence: number
  /** Absolute path of the file the material was written to. */
  readonly path: string
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Fetch the leased material and install it where the agent reads it.
 *
 * @param options - See {@link InstallAgentCredentialOptions}.
 * @returns The seat's identifiers and the path the material was written to.
 * @throws {BootstrapPhaseError} Naming `credential_install` (FR-051). The reason
 *   is the transport's own words and never quotes the material, because a phase
 *   failure is reported to the machine surface and written to the run log.
 */
export const installAgentCredential = async (
  options: InstallAgentCredentialOptions,
): Promise<InstalledAgentCredential> => {
  const context: RunPhaseContext = {
    reporter: options.reporter,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }

  return runPhase(
    'credential_install',
    async (): Promise<InstalledAgentCredential> => {
      let fetched: FetchedAgentCredential

      try {
        fetched = await options.source.fetchAgentCredential()
      } catch (cause) {
        throw new BootstrapPhaseError(
          'credential_install',
          `the leased agent credential could not be fetched from the machine surface: ${describe(
            cause,
          )}. The lease itself is not in doubt — it was reserved at admission, before this ` +
            'instance was provisioned (FR-016) — so this is a transport or control-plane fault ' +
            'rather than an exhausted pool.',
          { cause },
        )
      }

      // Registered before a single byte is written, so there is no moment at
      // which the material exists on this instance and the output pipeline does
      // not know to remove it (FR-014, SC-014).
      options.secrets.add(agentCredentialSecret(fetched.material))

      const directory = agentCredentialDir(options.workspaceRoot)
      const path = agentCredentialPath(options.workspaceRoot)

      try {
        await mkdir(directory, { recursive: true, mode: CREDENTIAL_DIR_MODE })
        // Explicit, because `mkdir`'s mode is masked by the process umask and a
        // credential directory that ended up group-readable would be readable by
        // whatever the bundle's `setup.sh` left running.
        await chmod(directory, CREDENTIAL_DIR_MODE)
        await writeFile(path, fetched.material, { mode: CREDENTIAL_FILE_MODE })
        await chmod(path, CREDENTIAL_FILE_MODE)
      } catch (cause) {
        throw new BootstrapPhaseError(
          'credential_install',
          `the agent credential could not be written to ${path}: ${describe(cause)}`,
          { cause },
        )
      }

      return { credentialId: fetched.credentialId, fence: fetched.fence, path }
    },
    context,
  )
}
