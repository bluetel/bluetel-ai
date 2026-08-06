/**
 * Running a child process during bootstrap (T046, T055).
 *
 * `tar`, `setup.sh` and `git` are all spawned through here so three properties
 * hold for all of them rather than for whichever call site remembered:
 *
 * 1. **Output is sanitised before it exists anywhere else.** `setup.sh` is
 *    arbitrary administrator-authored shell whose entire job is installing
 *    credentials, and FR-089 requires its output redacted to the same standard
 *    as agent output. The result type is {@link SanitisedText}, whose only
 *    construction site is `createSanitiser`, so a caller cannot accidentally
 *    persist the raw bytes — there are none to persist.
 * 2. **The process group dies, not just the leader.** `setup.sh` spawns package
 *    managers; a timeout that signals only the shell leaves them running on an
 *    instance about to be torn down. Spawning detached is what makes the
 *    negative pid mean the group.
 * 3. **An abort is honoured.** The phase timeout in `phases.ts` fires an
 *    `AbortSignal`; a phase that ignored it would fail on time and leak work.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

import { createSanitiser, EMPTY_SANITISED_TEXT } from '../output'
import type { KnownSecret, SanitisedText } from '../output'

export interface RunCommandOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Merged over the executor's own environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: Uint8Array
  /** Fired by the phase timeout; the group is killed when it does. */
  readonly signal?: AbortSignal
  /** Every credential the bundle installed, for known-value redaction. */
  readonly secrets?: readonly KnownSecret[]
  /** Sanitised output as it is produced, for live streaming to the panel. */
  readonly onOutput?: (text: SanitisedText) => void
}

export interface CommandResult {
  readonly exitCode: number | null
  readonly signal: string | null
  /** Combined stdout and stderr, stripped and redacted (FR-045, FR-089). */
  readonly output: SanitisedText
  /** True when the process was killed because the phase timeout fired. */
  readonly aborted: boolean
}

export const runCommand = (options: RunCommandOptions): Promise<CommandResult> =>
  new Promise<CommandResult>((resolveRun, rejectRun) => {
    const sanitiser = createSanitiser(
      options.secrets === undefined ? {} : { secrets: options.secrets },
    )
    const collected: string[] = []
    let aborted = false

    const child = spawn(options.command, [...(options.args ?? [])], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    const absorb = (chunk: string): void => {
      const clean = sanitiser.push(chunk)

      if (clean.length === 0) {
        return
      }

      collected.push(clean)
      options.onOutput?.(clean)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', absorb)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', absorb)

    const killGroup = (): void => {
      aborted = true

      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')

          return
        }
      } catch {
        // Group already gone, or the platform refused the negative pid.
      }

      child.kill('SIGKILL')
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        killGroup()
      } else {
        options.signal.addEventListener('abort', killGroup, { once: true })
      }
    }

    child.once('error', (error: Error) => {
      options.signal?.removeEventListener('abort', killGroup)
      rejectRun(error)
    })

    child.once('close', (code: number | null, signalName: NodeJS.Signals | null) => {
      options.signal?.removeEventListener('abort', killGroup)

      const tail = sanitiser.flush()

      if (tail.length > 0) {
        collected.push(tail)
        options.onOutput?.(tail)
      }

      resolveRun({
        exitCode: code,
        signal: signalName,
        // Concatenating sanitised pieces yields sanitised text: every stage in
        // the pipeline already held back anything that could span a boundary.
        output: (collected.length === 0
          ? EMPTY_SANITISED_TEXT
          : collected.join('')) as SanitisedText,
        aborted,
      })
    })

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })

/** A one-line summary for a phase failure detail. */
export const describeExit = (result: CommandResult): string =>
  result.signal === null
    ? `exited with code ${String(result.exitCode)}`
    : `was killed by ${result.signal}`
