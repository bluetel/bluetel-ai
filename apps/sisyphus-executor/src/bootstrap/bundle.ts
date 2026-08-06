/**
 * Bootstrap phases 2–5: download, verify, unpack, run `setup.sh` (T046).
 *
 * This is the part of a run that turns a bare instance into a worker able to do
 * one client's work (FR-087). It runs before any agent work, and it runs again
 * on a **restore** boot — that is what reinstalls the credentials a snapshot
 * deliberately does not carry (FR-072). Everything below is written on the
 * assumption that it will execute more than once against the same machine
 * state; see {@link SETUP_SCRIPT_IDEMPOTENCY_NOTE}.
 *
 * The governing requirement is FR-088 by way of FR-146: **a failure here names
 * its phase.** "Bootstrap failed" is the outcome those requirements exist to
 * prevent, because it leaves an administrator with an archive, a script and no
 * idea which of the two is wrong. Structurally, the phase name is not something
 * a call site remembers to include: every step goes through `runPhase`, and the
 * only failure type this module raises is `BootstrapPhaseError`, which cannot
 * be constructed without one.
 *
 * What is **not** checked, stated plainly because it looks like an omission:
 * the contents of the archive beyond `setup.sh`'s presence and mode.
 * `setup.sh` runs as arbitrary shell with the instance's privileges and
 * Sisyphus does not inspect what it does (setup-bundle.md → Trust boundary).
 * That rests entirely on bundles being administrator-authored, never
 * user-supplied.
 */

import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { KnownSecret, SanitisedText } from '../output'

import { ARCHIVE_NOT_FOUND, isCodedError } from './archive-store'
import type { BundleArchiveStore } from './archive-store'
import { BootstrapPhaseError, runPhase } from './phases'
import type { BootstrapPhaseName, BootstrapPhaseReporter, RunPhaseContext } from './phases'
import { describeExit, runCommand } from './run-command'

/** Required at the archive root, mode 0755 (setup-bundle.md → Archive format). */
export const SETUP_SCRIPT_NAME = 'setup.sh'

/**
 * The expectation a bundle author most often misses, in the words they will
 * read when they miss it.
 *
 * It is attached to the `bundle_unpack` failure message — the moment an author
 * building their first bundle is actually looking at executor output — and
 * returned on {@link BundleBootstrapResult.notes} so the validation-run record
 * (FR-148, T047) can surface it against the bundle version. Documenting
 * idempotency only in the contract means it is read once, by whoever read the
 * contract; a run that resumes from a snapshot and finds a half-installed
 * credential is discovered much later and much more expensively.
 */
export const SETUP_SCRIPT_IDEMPOTENCY_NOTE =
  'setup.sh must be idempotent: it runs on every boot, including the boot that restores a ' +
  'snapshot. Credential material under .agent-config/credentials/ is deliberately excluded from ' +
  'snapshots (FR-072), so re-running the bundle is how a resumed workflow gets its credentials ' +
  'back. A script that fails or double-installs on a second run breaks resume, not just setup.'

/** What the job envelope says about the bundle to fetch. */
export interface SetupBundleReference {
  readonly bundleId: string
  /** The administrator's name for the bundle; a failure must name it (FR-088). */
  readonly name: string
  readonly version: string
  readonly bucket: string
  readonly s3Key: string
  /** Lower-case hex sha256, captured from the bytes actually stored at upload. */
  readonly contentDigest: string
}

export interface BundleBootstrapOptions {
  readonly bundle: SetupBundleReference
  readonly store: BundleArchiveStore
  readonly reporter: BootstrapPhaseReporter
  /** Directory the archive is unpacked into. Created if absent. */
  readonly bundleDir: string
  /** `SISYPHUS_WORKSPACE_ROOT` — always the pinned root. */
  readonly workspaceRoot: string
  /** `SISYPHUS_AGENT_CONFIG_DIR` — inside the pinned root (FR-051). */
  readonly agentConfigDir: string
  /** `SISYPHUS_WORKFLOW_ID` — for log correlation only, not a credential. */
  readonly workflowId: string
  /** Credentials already known, for known-value redaction of setup output. */
  readonly secrets?: readonly KnownSecret[]
  readonly timeouts?: Partial<Record<BootstrapPhaseName, number>>
  /** Sanitised setup output as it is produced, for the live panel. */
  readonly onOutput?: (text: SanitisedText) => void
  readonly now?: () => number
}

export interface BundleBootstrapResult {
  readonly bundleDir: string
  readonly setupScriptPath: string
  readonly archiveBytes: number
  /** The digest of the bytes downloaded, which matched the registered one. */
  readonly contentDigest: string
  readonly setupOutput: SanitisedText
  /** Author-facing expectations worth recording against the version (FR-148). */
  readonly notes: readonly string[]
}

/**
 * sha256 of the bytes downloaded.
 *
 * Deliberately the same computation as the admin app's registration-time
 * digest (`apps/sisyphus-admin/src/lib/bundles/digest.ts`) and deliberately not
 * shared with it: the two live in different deployables, and the check is only
 * meaningful if this end computes it independently from the bytes it actually
 * received.
 */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

const describeBundle = (bundle: SetupBundleReference): string =>
  `setup bundle ${bundle.name} version ${bundle.version}`

/** Phase 2 — fetch the archive. */
export const downloadArchive = async (
  store: BundleArchiveStore,
  bundle: SetupBundleReference,
): Promise<Uint8Array> => {
  try {
    return await store.get({ bucket: bundle.bucket, key: bundle.s3Key })
  } catch (cause) {
    const reason = isCodedError(cause, ARCHIVE_NOT_FOUND)
      ? `${describeBundle(bundle)}: no archive is stored at ${bundle.s3Key}`
      : `${describeBundle(bundle)}: could not download ${bundle.s3Key} — ${
          cause instanceof Error ? cause.message : String(cause)
        }`

    throw new BootstrapPhaseError('bundle_download', reason, { cause })
  }
}

/**
 * Phase 3 — the digest the archive was registered with, against the bytes that
 * arrived.
 *
 * Not retryable, and that is the important part. Every other bootstrap failure
 * has a plausible transient cause; this one does not. The registered digest was
 * taken from the bytes handed to the object store, so a mismatch means the
 * object at that key is not the object that was registered — either it was
 * replaced, which immutability forbids (FR-090), or the transfer is corrupting.
 * Retrying re-downloads the same wrong bytes and burns instance time implying
 * the problem might go away.
 */
export const verifyArchiveDigest = (bundle: SetupBundleReference, bytes: Uint8Array): string => {
  const actual = sha256Hex(bytes)

  if (actual !== bundle.contentDigest.toLowerCase()) {
    throw new BootstrapPhaseError(
      'bundle_verify',
      `${describeBundle(bundle)}: the archive at ${bundle.s3Key} hashes to sha256:${actual}, ` +
        `which is not the digest registered at upload (sha256:${bundle.contentDigest}). ` +
        'A digest mismatch is never transient, so this is not recoverable by retry; ' +
        'the agent is not started.',
      { retryable: false },
    )
  }

  return actual
}

/**
 * Phase 4 — unpack, then assert an executable `setup.sh` at the archive root.
 *
 * Shelling out to `tar` rather than decoding in process: it is present on every
 * target image, it is what a bundle author used to create the archive, and a
 * hand-rolled tar reader is a parser for a format with several incompatible
 * dialects. Extraction is bounded by the phase timeout through the abort
 * signal, so a decompression bomb costs the phase rather than the instance.
 */
export const unpackArchive = async (
  bundle: SetupBundleReference,
  bytes: Uint8Array,
  bundleDir: string,
  signal: AbortSignal,
): Promise<void> => {
  await mkdir(bundleDir, { recursive: true })

  const result = await runCommand({
    command: 'tar',
    args: ['-x', '-z', '-f', '-', '-C', bundleDir],
    stdin: bytes,
    signal,
  })

  if (result.exitCode !== 0) {
    throw new BootstrapPhaseError(
      'bundle_unpack',
      `${describeBundle(bundle)}: tar ${describeExit(result)} unpacking ${bundle.s3Key}. ` +
        `The archive must be a gzipped tar. ${result.output.trim()}`.trim(),
    )
  }
}

/** The `setup.sh` assertions, which belong to the unpack phase (FR-083, FR-088). */
export const assertSetupScript = async (
  bundle: SetupBundleReference,
  bundleDir: string,
): Promise<string> => {
  const scriptPath = join(bundleDir, SETUP_SCRIPT_NAME)

  const reject = (reason: string): never => {
    throw new BootstrapPhaseError(
      'bundle_unpack',
      `${describeBundle(bundle)}: ${reason}. ${SETUP_SCRIPT_IDEMPOTENCY_NOTE}`,
    )
  }

  let entry: Awaited<ReturnType<typeof stat>>

  try {
    entry = await stat(scriptPath)
  } catch {
    return reject(`no ${SETUP_SCRIPT_NAME} at the archive root`)
  }

  if (!entry.isFile()) {
    return reject(`${SETUP_SCRIPT_NAME} at the archive root is not a regular file`)
  }

  // Any execute bit will do. The contract asks for 0755; refusing 0700 would
  // fail a bundle that works, and refusing nothing would defer the failure to
  // an EACCES from the shell with no phase attached to it.
  if ((entry.mode & 0o111) === 0) {
    return reject(
      `${SETUP_SCRIPT_NAME} at the archive root is not executable ` +
        `(mode ${(entry.mode & 0o777).toString(8)}; it must have an execute bit, and 0755 is ` +
        'what the contract asks for)',
    )
  }

  return scriptPath
}

/**
 * Phase 5 — run `setup.sh` to completion.
 *
 * The exit code is the whole success signal (setup-bundle.md). Output goes
 * through the sanitiser on the way out of the child process, so a script that
 * echoes a credential cannot leak it into the log (FR-089) — and there is no
 * moment at which a copy that has not been redacted exists anywhere but in
 * the pipe.
 */
export const runSetupScript = async (
  bundle: SetupBundleReference,
  options: BundleBootstrapOptions,
  scriptPath: string,
  signal: AbortSignal,
): Promise<SanitisedText> => {
  const result = await runCommand({
    command: scriptPath,
    cwd: options.bundleDir,
    env: {
      SISYPHUS_WORKSPACE_ROOT: options.workspaceRoot,
      SISYPHUS_AGENT_CONFIG_DIR: options.agentConfigDir,
      SISYPHUS_WORKFLOW_ID: options.workflowId,
    },
    signal,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
  })

  if (result.exitCode !== 0) {
    throw new BootstrapPhaseError(
      'setup_script',
      `${describeBundle(bundle)}: ${SETUP_SCRIPT_NAME} ${describeExit(result)}`,
    )
  }

  return result.output
}

/**
 * Phases 2–5, in order, each timed and reported individually.
 *
 * Runs once per boot regardless of entry count, and on a restore boot too.
 */
export const runBundleBootstrap = async (
  options: BundleBootstrapOptions,
): Promise<BundleBootstrapResult> => {
  const { bundle, reporter } = options
  const context = (phase: BootstrapPhaseName): RunPhaseContext => ({
    reporter,
    ...(options.timeouts?.[phase] === undefined ? {} : { timeoutMs: options.timeouts[phase] }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const archive = await runPhase(
    'bundle_download',
    () => downloadArchive(options.store, bundle),
    context('bundle_download'),
  )

  const contentDigest = await runPhase(
    'bundle_verify',
    () => Promise.resolve(verifyArchiveDigest(bundle, archive)),
    context('bundle_verify'),
  )

  const setupScriptPath = await runPhase(
    'bundle_unpack',
    async (signal) => {
      await unpackArchive(bundle, archive, options.bundleDir, signal)

      return assertSetupScript(bundle, options.bundleDir)
    },
    context('bundle_unpack'),
  )

  const setupOutput = await runPhase(
    'setup_script',
    (signal) => runSetupScript(bundle, options, setupScriptPath, signal),
    context('setup_script'),
  )

  return {
    bundleDir: options.bundleDir,
    setupScriptPath,
    archiveBytes: archive.byteLength,
    contentDigest,
    setupOutput,
    notes: [SETUP_SCRIPT_IDEMPOTENCY_NOTE],
  }
}
