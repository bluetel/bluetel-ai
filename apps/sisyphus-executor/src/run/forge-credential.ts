/* cspell:words netrc */
/**
 * **Reading the repository-host credential the setup bundle installed (FR-075, FR-072).**
 *
 * `delivery/forge-http.ts` takes a `credential: () => string | Promise<string>` and cannot obtain
 * one for itself. This module is the one that can, and the whole design is in *where it asks*.
 *
 * ## It is not the envelope's credential, and that is not a detail
 *
 * `envelope.scopedCredential` is workflow-scoped, short-lived and minted for the **machine
 * surface** (FR-037). `env-schemas.ts` lists `SISYPHUS_SCOPED_CREDENTIAL` in `ENVELOPE_ONLY_KEYS`
 * precisely so it stays on that one boundary. Sending it to a code host would present a Sisyphus
 * platform credential to a third party that has no business holding one — so it is not used here,
 * and the code host's credential is not in the envelope at all.
 *
 * ## There is no file path to read, on purpose
 *
 * `contracts/setup-bundle.md` gives the bundle a `credentials/` directory holding "whatever
 * setup.sh needs", written under `/workspace/.agent-config/credentials/`. Deliberately unnamed:
 * the contract does not say what is in it, and every bundle already in a client's hands was
 * authored against that freedom. Inventing `credentials/forge-token` here would be a change to the
 * bundle format dressed up as an implementation detail, and every existing bundle would silently
 * fail to satisfy it.
 *
 * ## So ask git
 *
 * The bundle has *already* had to make git able to clone the workspace entries — phase 6 does
 * exactly that, with the bundle's credentials and nothing else — so whatever form the bundle chose
 * (a helper, a store file, an `insteadOf` rewrite, a `.netrc`), git can already produce the
 * credential for that host. `git credential fill` is the interface to that, it is part of git's
 * public plumbing, and asking it needs **no contract change** and works with every bundle that
 * works at all.
 *
 * ## Phase 5 (`setup_script`) must have completed first
 *
 * The credential does not exist on the instance until `setup.sh` has installed it, which is
 * bootstrap phase 5 — `BOOTSTRAP_PHASES[4]`. `run/assemble.ts` builds this object before phase 1,
 * so it must not *read* at construction: resolution is lazy, on first use, and the first use is a
 * delivery step, which cannot be reached until phases 2–7 have all succeeded (`run/bootstrap.ts`
 * runs them in order and `run/execute.ts` dispatches the workflow only afterwards). Resolving
 * eagerly would query git before the bundle had run and fail every run with a missing credential.
 *
 * There is no `cwd`, and phase ordering is also the reason: `setup.sh` runs before any repository
 * is checked out (phase 6), so it cannot have written a repository-local git config. Anything it
 * installed is global to the instance, which is what a fill from the executor's own directory
 * sees.
 *
 * ## Why this is not in `src/delivery/`
 *
 * `delivery/git.ts` guards every git invocation with `READ_ONLY_GIT_COMMANDS`, and the value
 * of that allow-list is that it is short and total. `credential` is not a read-only repository
 * query — it is the one subcommand that hands out a secret — and adding it to that list to reuse
 * the runner would weaken the guarantee the list exists to make. `git.ts` is left exactly as it
 * is, and this module spawns its own process through its own injected seam.
 *
 * ## The value goes nowhere
 *
 * `git credential fill` prints `password=…` on **stdout**. It is parsed, held in one closure
 * variable, and handed to `createHttpForge`, which puts it in an `Authorization` header and
 * nowhere else. It is never logged, never written to stdout, and never interpolated into an error
 * — every failure below is constructed from the host, the exit status and a
 * {@link credentialDiagnostic}-sanitised excerpt of **stderr**, from which any credential-shaped
 * line has been dropped before pattern redaction runs over what is left.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

import { parseRepositoryLocation } from '../delivery'
import { createRedactor } from '../output'

/** Long enough for a helper that talks to a keyring; short enough not to hold a paid instance. */
export const DEFAULT_CREDENTIAL_FILL_TIMEOUT_MS = 15_000

/**
 * Set for the fill, so a missing helper *fails* instead of blocking on a prompt.
 *
 * An instance has no terminal, but `git credential fill` will still sit waiting on one, and a
 * bootstrap that hangs is worse than a bootstrap that fails: the timeout below is the backstop,
 * this is the thing that makes the backstop unnecessary.
 */
export const CREDENTIAL_FILL_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0' }

/** How much of git's stderr a failure may quote. A helper can be chatty. */
export const MAX_CREDENTIAL_DIAGNOSTIC_LENGTH = 200

export interface CredentialFillCommand {
  /** Always `['credential', 'fill']`; passed rather than assumed so a test can assert it. */
  readonly args: readonly string[]
  /** git's key-value request, terminated by a blank line. */
  readonly stdin: string
  /** Merged over the executor's own environment. */
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface CredentialFillResult {
  /** git's answer, in its key-value protocol. **Carries the credential.** */
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  /** True when the timeout fired and the child was killed. */
  readonly timedOut: boolean
}

/**
 * How the fill is performed.
 *
 * Injected for the reason every seam in this application is injected: no test may spawn a real
 * `git credential`, which on a developer's machine would query their own keychain.
 */
export type CredentialFiller = (command: CredentialFillCommand) => Promise<CredentialFillResult>

export type ForgeCredentialFailure =
  /** git could not be run at all — not on `PATH`, or not executable. */
  | 'unavailable'
  /** git ran and refused: no helper answered for this host. */
  | 'refused'
  /** git answered, and its answer names no password. */
  | 'empty'
  | 'timed_out'

export class ForgeCredentialError extends Error {
  readonly kind: ForgeCredentialFailure
  /** The authority the fill asked about. Never carries user information. */
  readonly host: string

  constructor(kind: ForgeCredentialFailure, host: string, reason: string, cause?: unknown) {
    super(reason, cause === undefined ? {} : { cause })
    this.name = 'ForgeCredentialError'
    this.kind = kind
    this.host = host
  }
}

/**
 * A bounded, credential-free excerpt of git's stderr.
 *
 * Two passes, in this order. Any line in git's own key-value shape is **dropped whole** — a broken
 * helper that echoes `password=…` on stderr must not have it quoted back into a run record — and
 * whatever survives goes through the executor's pattern redactor, which is the same backstop
 * `setup.sh` output gets (FR-072, FR-089).
 *
 * @param text - Whatever git wrote to stderr.
 * @returns A single line, safe to put in a failure message.
 */
export const credentialDiagnostic = (text: string): string => {
  const { redact } = createRedactor()
  const kept = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(?:password|username|credential)(?:\[\])?=/iu.test(line))
    .join('; ')
  const clean = redact(kept)

  return clean.length > MAX_CREDENTIAL_DIAGNOSTIC_LENGTH
    ? `${clean.slice(0, MAX_CREDENTIAL_DIAGNOSTIC_LENGTH)}…`
    : clean
}

/**
 * The password out of git's key-value answer, or `undefined` if it named none.
 *
 * Split at the **first** `=`, because a token may contain one and the key never does. Exported so
 * the parse is tested directly rather than only through a spawned process.
 *
 * @param stdout - git's answer.
 * @returns The credential, or `undefined` when there is no non-empty `password` line.
 */
export const passwordFrom = (stdout: string): string | undefined => {
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/u, '')
    const separator = line.indexOf('=')

    if (separator > 0 && line.slice(0, separator) === 'password') {
      const value = line.slice(separator + 1)

      return value === '' ? undefined : value
    }
  }

  return undefined
}

/** git's request format: one `key=value` per line, terminated by a blank line. */
export const credentialQuery = (input: {
  readonly protocol: string
  readonly host: string
}): string => `protocol=${input.protocol}\nhost=${input.host}\n\n`

/**
 * The real filler. Spawns `git credential fill` and returns its raw answer.
 *
 * Raw is required: the bootstrap `runCommand` returns `SanitisedText`, and a sanitiser that
 * removed a credential-shaped string is exactly what must not happen to the one output whose
 * entire content is a credential.
 */
export const createProcessCredentialFiller =
  (): CredentialFiller =>
  async (command): Promise<CredentialFillResult> =>
    new Promise<CredentialFillResult>((resolveFill, rejectFill) => {
      const child = spawn('git', [...command.args], {
        env: { ...process.env, ...command.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const out: string[] = []
      const err: string[] = []
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, command.timeoutMs)

      timer.unref()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => out.push(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => err.push(chunk))

      // `ENOENT` lands here: git is not on this instance's PATH.
      child.once('error', (error: Error) => {
        clearTimeout(timer)
        rejectFill(error)
      })

      child.once('close', (code: number | null) => {
        clearTimeout(timer)
        resolveFill({ stdout: out.join(''), stderr: err.join(''), exitCode: code, timedOut })
      })

      child.stdin.end(command.stdin)
    })

export interface ForgeCredentialOptions {
  /**
   * A repository this run works on, in whatever form the workspace recorded it. Only its host is
   * used, and it is parsed by `delivery/forge-repository.ts` rather than by a second parser here.
   */
  readonly repositoryUrl: string
  /** Injected in tests. Production spawns the real binary. */
  readonly fill?: CredentialFiller
  readonly timeoutMs?: number
}

export interface ForgeCredential {
  /**
   * The credential, resolved on first call and cached.
   *
   * Safe to call from anywhere in the delivery path: concurrent callers share one fill, and the
   * value is only ever read after bootstrap phase 5 has installed it.
   */
  readonly read: () => Promise<string>
}

/**
 * Build the lazy accessor `createHttpForge` takes.
 *
 * @param options - The repository whose host to ask about, and the injected filler.
 * @returns An accessor that resolves the credential once and then answers from memory.
 */
export const createForgeCredential = (options: ForgeCredentialOptions): ForgeCredential => {
  const fill = options.fill ?? createProcessCredentialFiller()
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREDENTIAL_FILL_TIMEOUT_MS

  let resolved: string | undefined
  let inFlight: Promise<string> | undefined

  const fillOnce = async (): Promise<string> => {
    // Parsed here rather than at construction: a reference that names no host must fail the
    // delivery step that needed it, not the assembly that happens before anything can report.
    const location = parseRepositoryLocation(options.repositoryUrl)
    const { host } = location
    const where = `${location.protocol}://${host}`

    let answer: CredentialFillResult

    try {
      answer = await fill({
        args: ['credential', 'fill'],
        stdin: credentialQuery(location),
        env: CREDENTIAL_FILL_ENV,
        timeoutMs,
      })
    } catch (cause) {
      throw new ForgeCredentialError(
        'unavailable',
        host,
        `git could not be run on this instance, so the ${host} credential the setup bundle ` +
          `installed cannot be read (FR-075): ${credentialDiagnostic(
            cause instanceof Error ? cause.message : String(cause),
          )}. No pull request was opened.`,
        cause,
      )
    }

    if (answer.timedOut) {
      throw new ForgeCredentialError(
        'timed_out',
        host,
        `git credential fill did not answer for ${where} within ${String(timeoutMs)}ms and was ` +
          'killed. A credential helper that blocks — on a prompt, a keyring or a network call — ' +
          'stalls every delivery step, so the run stops here rather than waiting. No pull ' +
          'request was opened.',
      )
    }

    if (answer.exitCode !== 0) {
      const detail = credentialDiagnostic(answer.stderr)

      throw new ForgeCredentialError(
        'refused',
        host,
        `no git credential helper answered for ${where} (git credential fill exited ` +
          `${String(answer.exitCode)})${detail === '' ? '' : `: ${detail}`}. The setup bundle is ` +
          'what installs every integration credential (FR-075), and whatever it configured for ' +
          'this host — a helper, a store, a rewritten remote — either is not configured or ' +
          'holds nothing for it. No pull request was opened.',
      )
    }

    const password = passwordFrom(answer.stdout)

    if (password === undefined) {
      throw new ForgeCredentialError(
        'empty',
        host,
        `git credential fill succeeded for ${where} but named no password, so there is no ` +
          'credential to present to the code host. An empty credential would be sent and ' +
          'refused as an unauthorised request several steps later, naming the wrong cause, so ' +
          'the run stops here. No pull request was opened.',
      )
    }

    return password
  }

  return {
    read: async (): Promise<string> => {
      if (resolved !== undefined) {
        return resolved
      }

      inFlight ??= fillOnce()

      try {
        const value = await inFlight

        resolved = value

        return value
      } catch (failure) {
        // Deliberately not cached. A helper that was momentarily unavailable should be asked
        // again by the next attempt; a genuinely absent one fails again, identically, and the
        // forge's retry policy bounds how often that happens.
        inFlight = undefined

        throw failure
      }
    },
  }
}
