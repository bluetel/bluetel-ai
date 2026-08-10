/**
 * **Write-through of a mid-run credential rotation (003/T058, FR-014, FR-020,
 * FR-030, FR-032, research R3).**
 *
 * The agent refreshes its own login while it works. Nothing tells the platform
 * when: there is no callback, no exit code and no line of output that says it
 * happened. What there is, on Linux, is a file that changes. So this module
 * watches that file, and on every change reads it and posts the bytes to the
 * machine surface under the lease's fencing value.
 *
 * **Write-through rather than write-at-the-end is the entire point.** R1 chose
 * the pessimistic rule — assume a rotation invalidates its predecessor
 * immediately — which makes an unpersisted rotation a *bricked seat*: the
 * material the platform holds no longer works, and the copy that does works only
 * on a disk that is about to be thrown away. Persisting as it happens bounds the
 * blast radius of a hard instance death to a single in-flight rotation. Reading
 * once at teardown would lose the whole session's worth, on exactly the deaths
 * this feature exists to survive.
 *
 * ## Linux, and why a developer machine does not test this
 *
 * R3 records the constraint: the on-disk location and format are
 * platform-specific, and on macOS the agent may keep this material in the OS
 * keychain rather than in a file at all. The executor's target is Linux, this
 * watcher is written against Linux file behaviour, and **running it locally
 * proves nothing about the path it is for**. The colocated test therefore
 * supplies a synthetic file of its own: it never looks for a real agent login,
 * because on the machine a developer runs it there may not be one to look at.
 *
 * The Linux behaviour that shapes the implementation is *how* a credential file
 * is replaced. A careful writer does not modify in place — it writes a temporary
 * file and `rename`s it over the target, which is atomic and which gives the
 * path a **new inode**. An `fs.watch` bound to the old file would then be
 * watching a file nobody will ever write to again, and would go silent forever
 * after the first rotation. So the watch is on the **directory**, filtered to the
 * one filename, which sees the rename, the create and the in-place write alike.
 *
 * ## Debounce
 *
 * A single rotation is several filesystem events — a create, one or more writes,
 * a rename, a chmod — and reading between two of them yields a half-written
 * file. The debounce coalesces a burst into one read, and the read is what the
 * surface is told about. It is a delay, not a sample: every burst produces
 * exactly one report, none is dropped, and {@link RotationWatch.flush} exists so
 * a burst that is still inside its debounce window when the run suspends is not
 * lost.
 *
 * ## The two rejections mean opposite things
 *
 * `reportCredentialRotation` **answers** a refusal rather than throwing one, and
 * the two reasons are handled differently on purpose:
 *
 * - **`stale_fence`** — the fence presented is below the credential's current
 *   value, so this instance's claim has already been superseded and something
 *   else has held the seat since. The watch **stops, permanently**. Retrying
 *   would be a retry storm of writes that are all going to be refused for the
 *   same reason, and — worse — this instance's material is now the *old*
 *   material; if a write of it ever were accepted it would overwrite a newer
 *   credential with a dead one.
 * - **`not_newer`** — the fence is current and the bytes are the bytes already
 *   stored. An ordinary event on a healthy holder: a touch that changed nothing.
 *   The watch carries on.
 *
 * A rejection is therefore never treated as a transport error, and a transport
 * error is never treated as a rejection: an unreachable surface leaves the
 * material **pending**, so the next change — or the suspend flush — sends it
 * again.
 *
 * ## Material handling
 *
 * Every value read here is registered as a known redaction value **before** it
 * is reported (FR-014), so the newest material is known to the output pipeline
 * from the moment this process has read it. Nothing in this module logs the
 * bytes, returns them, or puts them into an error.
 */

import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import type { SecretRegistry } from '../output'
import { agentCredentialSecret } from '../output'

/** Why a rotation was not written. The contract's closed vocabulary (FR-020). */
export type CredentialRotationRejection = 'stale_fence' | 'not_newer'

/**
 * What `machine.reportCredentialRotation` answers with.
 *
 * A discriminated union rather than a boolean and an optional reason, because a
 * bare `false` cannot distinguish "you have lost the seat" from "nothing to do",
 * and those are the only two answers there are.
 *
 * Restated structurally rather than imported from the API package's router
 * types, exactly as `bootstrap/credential-install.ts` restates the fetch: the
 * executor's only edge to that package is `import type` from `/client`, and
 * `report/client.ts` is where router-derived types live. Its implementation
 * satisfies this shape structurally, so the two cannot drift without failing to
 * compile at the call site.
 */
export type CredentialRotationAnswer =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: CredentialRotationRejection }

export interface CredentialRotationReporter {
  readonly reportCredentialRotation: (input: {
    readonly fence: number
    readonly material: string
  }) => Promise<CredentialRotationAnswer>
}

/**
 * How the credential file is watched. Injected only so the debounce and the
 * answer handling can be tested without racing a real filesystem; production
 * passes nothing and gets {@link watchCredentialFile}.
 *
 * @returns A function that stops the watch. Called exactly once.
 */
export type CredentialFileWatcher = (path: string, onChange: () => void) => () => void

/**
 * The real watch: on the **directory**, filtered to the one filename.
 *
 * See the module note — a credential replaced by `rename` gets a new inode, and
 * a watch bound to the file would never fire again. Watching the directory also
 * covers the first appearance of a file that did not exist when the watch
 * started, which is what a boot whose `credential_install` raced the watcher
 * would otherwise miss.
 *
 * `filename` is nullable in Node's typings because some platforms do not supply
 * it. Treating that as "something in this directory changed, look" is the safe
 * direction: at worst it costs a read of a small file.
 */
export const watchCredentialFile: CredentialFileWatcher = (path, onChange) => {
  const name = basename(path)
  const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
    if (filename === null || basename(filename) === name) {
      onChange()
    }
  })

  return () => {
    watcher.close()
  }
}

/**
 * How long a burst of filesystem events is coalesced for.
 *
 * Long enough that a create-write-rename sequence is one read rather than three,
 * short enough that a rotation is persisted well inside the window in which the
 * instance could die. It is not a bound on anything: `flush()` is what
 * guarantees a rotation observed moments before a suspend is not lost.
 */
export const DEFAULT_ROTATION_DEBOUNCE_MS = 250

/** Why a flush ended, for the caller that asked for it. */
export type RotationFlushOutcome =
  /** Nothing had changed since the last accepted write. */
  | 'nothing-pending'
  /** The material was written through. */
  | 'reported'
  /** The surface said the bytes were already stored (`not_newer`). */
  | 'already-stored'
  /** This instance has lost its claim; the watch has stopped (`stale_fence`). */
  | 'claim-lost'
  /** The file could not be read, or the surface could not be reached. */
  | 'failed'

export interface RotationWatchOptions {
  /** The agent's credential file — `bootstrap/credential-install.ts` owns the path. */
  readonly path: string
  /**
   * The fence this instance must present (FR-020).
   *
   * The credential's value **as at the fetch**, which is what
   * `fetchAgentCredential` answered with — not the `leaseFence` the envelope
   * carried. Where the two differ this instance has already lost its claim, and
   * presenting the fetched value is what makes that discoverable as a
   * `stale_fence` rather than as an accepted write of superseded material.
   */
  readonly fence: number
  readonly reporter: CredentialRotationReporter
  /** The run's known-value redaction set (FR-014). Required, for `credential-install`'s reason. */
  readonly secrets: SecretRegistry
  /**
   * The material `credential_install` wrote, if the caller has it.
   *
   * Seeds "what the platform already holds", so the writer's own write does not
   * come straight back as a rotation. Omitting it costs one request answered
   * `not_newer`, which is precisely the case that rejection exists for — so this
   * is an optimisation, not a correctness requirement.
   */
  readonly installedMaterial?: string
  readonly debounceMs?: number
  readonly watcher?: CredentialFileWatcher
  /** Injected in tests; production reads the file. */
  readonly read?: (path: string) => Promise<string>
  /** A rotation was written through. The material is deliberately not passed. */
  readonly onRotationReported?: () => void
  /**
   * This instance's claim has been superseded and the watch has stopped.
   *
   * Reported rather than thrown: the run is still running and still holds a
   * working tree worth snapshotting, and a rejected write is a statement about
   * the *seat*, not about the work. What the caller does with it — wind the run
   * down, record a condition — is not this module's decision.
   */
  readonly onClaimLost?: () => void
  /** A read or a report failed. Never fatal: the material stays pending. */
  readonly onFailure?: (error: unknown, detail: string) => void
}

export interface RotationWatch {
  /**
   * Persist anything observed but not yet written through, now.
   *
   * Called from `session/suspend.ts` on every suspension path (FR-030, R3). It
   * cancels the debounce rather than waiting it out, and it reads the file even
   * when no event is outstanding — a filesystem event that never arrived is
   * indistinguishable from one that has not arrived yet, and the read is cheap
   * next to the cost of being wrong about it.
   *
   * **Never rejects.** A suspension that failed because a credential write
   * failed would also lose the snapshot, and the snapshot is the work; failures
   * go to {@link RotationWatchOptions.onFailure} and are reported in the
   * outcome instead.
   */
  readonly flush: () => Promise<RotationFlushOutcome>
  /** Stop watching. Idempotent; safe after a `stale_fence` has already stopped it. */
  readonly stop: () => void
  /** True once a `stale_fence` rejection has ended this instance's claim. */
  readonly hasLostClaim: boolean
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Start watching the agent's credential file.
 *
 * @param options - See {@link RotationWatchOptions}.
 * @returns The handle `suspend()` flushes through and the run stops at teardown.
 */
export const watchForRotation = (options: RotationWatchOptions): RotationWatch => {
  const read = options.read ?? ((path: string) => readFile(path, 'utf8'))
  const debounceMs = options.debounceMs ?? DEFAULT_ROTATION_DEBOUNCE_MS

  /** The bytes the platform is known to hold. Nothing equal to this is worth sending. */
  let stored = options.installedMaterial
  let lostClaim = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Serialises reports, so two bursts cannot post the same seat's material at once. */
  let inFlight: Promise<RotationFlushOutcome> = Promise.resolve('nothing-pending')
  /**
   * How the watch is torn down. Assigned at the bottom of this function, and initialised to a
   * no-op only because the graph is circular by construction: `stop` needs it, it needs
   * `onChange`, and `onChange` reaches `stop` through a `stale_fence` rejection. Nothing can call
   * `stop` before the assignment — the handle does not exist until this function returns.
   */
  let unwatch: () => void = () => undefined

  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    if (!stopped) {
      stopped = true
      unwatch()
    }
  }

  const persist = async (): Promise<RotationFlushOutcome> => {
    if (lostClaim) {
      return 'claim-lost'
    }

    let material: string

    try {
      material = await read(options.path)
    } catch (cause) {
      // A missing file is not an error worth escalating on its own — the agent
      // may not have written one yet on this boot — but it is not silence
      // either, because the same message is what a permissions problem looks
      // like. The path is named; the bytes never are.
      options.onFailure?.(cause, `reading the agent credential file: ${describe(cause)}`)

      return 'failed'
    }

    if (material === '' || material === stored) {
      // An empty read is a truncated write caught mid-rotation, not a rotation:
      // the contract refuses an empty payload for the same reason, and sending
      // one would ask the platform to overwrite a working credential with
      // nothing.
      return 'nothing-pending'
    }

    // Known to the output pipeline before it is known to anything else
    // (FR-014). A report that failed still leaves the value registered, which
    // is the safe direction.
    options.secrets.add(agentCredentialSecret(material))

    let answer: CredentialRotationAnswer

    try {
      answer = await options.reporter.reportCredentialRotation({
        fence: options.fence,
        material,
      })
    } catch (cause) {
      // Transport, not refusal. `stored` is deliberately left alone, so the next
      // change — or the suspend flush — sends this material again.
      options.onFailure?.(cause, `reporting a credential rotation: ${describe(cause)}`)

      return 'failed'
    }

    if (answer.accepted) {
      stored = material
      options.onRotationReported?.()

      return 'reported'
    }

    if (answer.reason === 'not_newer') {
      // The platform already holds these bytes. Recording that locally is what
      // stops the next touch asking again.
      stored = material

      return 'already-stored'
    }

    // `stale_fence`. The seat is somebody else's now; this instance must stop
    // writing to it, and it must not retry.
    lostClaim = true
    stop()
    options.onClaimLost?.()

    return 'claim-lost'
  }

  /** Run `persist` behind whatever is already running, and never reject. */
  const queue = (): Promise<RotationFlushOutcome> => {
    inFlight = inFlight.then(persist, persist)

    return inFlight
  }

  const onChange = (): void => {
    if (lostClaim || stopped) {
      return
    }

    if (timer !== undefined) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = undefined
      void queue()
    }, debounceMs)

    timer.unref()
  }

  unwatch = (options.watcher ?? watchCredentialFile)(options.path, onChange)

  return {
    flush: async (): Promise<RotationFlushOutcome> => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }

      return queue()
    },
    stop,
    get hasLostClaim() {
      return lostClaim
    },
  }
}
