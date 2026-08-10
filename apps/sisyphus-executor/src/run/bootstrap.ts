/**
 * **Bootstrap phases 2–7, composed (T173, FR-112, FR-145, FR-146, contracts/executor-protocol.md).**
 *
 * Every phase in this file already existed and was tested. What did not exist was the sequence:
 * `runBundleBootstrap` had no caller, `checkoutWorkspace` had no caller, and `startAgentPhase` had
 * no caller, so the ordering that FR-112 and the protocol table actually specify lived only in
 * prose. This module is that ordering, and it is the shortest function in the run for a reason —
 * there is nothing here but the order, and the order is the requirement.
 *
 * ```
 * prepareWorkspaceRoot          the config tree exists before setup.sh is promised it
 * 2-5  runBundleBootstrap       download, verify, unpack, run setup.sh
 *      registerBundleCredentials  what setup.sh installed, into the run's redactor  (T239)
 * 5a   installAgentCredential   the leased seat's material, from the machine surface
 * 6    checkoutWorkspace        every entry, sequentially, or none
 * 7    startAgentPhase          against a ReadyWorkspace and nothing else
 * ```
 *
 * ## Phase 6 cannot be skipped, and that is a type rather than a comment
 *
 * `startAgentPhase` takes a `ReadyWorkspace`, which `checkoutWorkspace` alone constructs and only
 * from a checkout in which every entry succeeded. There is no value this module could assemble by
 * hand that would satisfy it, so "the agent never starts against an incomplete workspace" is
 * enforced by the compiler here as it is at the call site (FR-112).
 *
 * ## Phases 2–5 run on a restore boot too
 *
 * They are not conditional on `resumeFromSnapshot`, and the protocol is explicit about why: a
 * snapshot deliberately excludes the credential subtree (FR-072), so re-running the bundle is how a
 * resumed workflow gets its **repository-host and third-party** credentials back. Restore replaces
 * phases 6 and 7, never 2–5.
 *
 * ## Phase 5a runs on **every** boot, and there is no branch for it to escape through (003/FR-050)
 *
 * `installAgentCredential` sits between the bundle and the checkout — after `setup_script`, because
 * the bundle is what puts the agent CLI on the box; before `entry_checkout`, because there is no
 * reason to clone a customer's repositories for a run that cannot authenticate.
 *
 * It is a straight-line `await` in this function, with nothing conditional anywhere near it, and
 * that is deliberate rather than incidental. This function is the **only** boot path the executor
 * has: `main.ts` parses an envelope and calls `assembleRun`, `run/execute.ts` calls this, and there
 * is no second sequence for a restore or a resume. A restore boot is this same call with
 * `resumeFromSnapshot` set — a value read in exactly one place, `startAgentPhase`'s
 * `resumeSessionId` — and a resumed-instance boot is this same call on a machine that was stopped
 * rather than terminated. So "the credential is installed on every boot" is not a rule anybody has
 * to remember: there is no code path here that reaches phase 6 without having run 5a first, and
 * `bootstrap.test.ts` asserts it against a restore envelope as well as a first boot.
 *
 * That matters most in the case that looks like it should be an optimisation. A **stopped**
 * instance still has the previous boot's material on its disk, and skipping the fetch would look
 * free — but the credential may have rotated while the instance was not running, and a run that
 * starts with a superseded token fails somewhere much less legible than a bootstrap phase.
 *
 * ## Nothing here reports to the machine surface
 *
 * The phase reporter is injected. `runPhase` announces starts and outcomes through it, and whether
 * those go to the machine surface, to a test's array, or to both is the caller's decision — which
 * is what lets the whole sequence be exercised without a network.
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { AgentAdapter } from '../agent'
import type {
  AgentCredentialSource,
  BootstrapPhaseName,
  BootstrapPhaseReporter,
  BundleArchiveStore,
  BundleBootstrapResult,
  CheckedOutEntry,
  InstalledAgentCredential,
  ReadyWorkspace,
  SetupBundleReference,
  StartedAgent,
  WorkspaceEntry,
} from '../bootstrap'
import {
  agentConfigDir,
  AGENT_CREDENTIAL_FILE_NAME,
  agentCredentialDir,
  checkoutWorkspace,
  installAgentCredential,
  prepareWorkspaceRoot,
  runBundleBootstrap,
  startAgentPhase,
} from '../bootstrap'
import type { EnvelopeSetupBundle, WorkflowJobEnvelope } from '../job-envelope'
import type { KnownSecret, SanitisedText, SecretRegistry } from '../output'
import { bundleCredentialSecrets, sanitise } from '../output'
import type { SkillSource } from '../skills'
import { primarySkillSource } from '../skills'

/**
 * The envelope's bundle reference, in the shape the bootstrap path takes.
 *
 * The two disagree on two fields, and the bridge is here rather than in either module. The
 * envelope carries `{ s3Key, contentDigest, version }` — everything needed to *fetch and verify* —
 * while `SetupBundleReference` also carries `bundleId` and `name`, which exist so an FR-088 failure
 * can name the bundle an administrator would recognise. The envelope does not carry that name, so
 * the key stands in for it: it is what identifies the archive on this instance, and a failure that
 * says which object could not be verified is more use than one that says nothing at all.
 *
 * @param bundle - The envelope's reference.
 * @param bucket - `SISYPHUS_BUNDLES_BUCKET`, which is instance configuration and never the
 *   envelope's to name.
 */
export const setupBundleReference = (
  bundle: EnvelopeSetupBundle,
  bucket: string,
): SetupBundleReference => ({
  bundleId: bundle.s3Key,
  name: bundle.s3Key,
  version: String(bundle.version),
  bucket,
  s3Key: bundle.s3Key,
  contentDigest: bundle.contentDigest,
})

/** The envelope's workspace entries, in the shape phase 6 takes. */
export const workspaceEntries = (envelope: WorkflowJobEnvelope): readonly WorkspaceEntry[] =>
  envelope.workspace.entries.map((entry) => ({
    entryId: entry.entryId,
    repositoryUrl: entry.repositoryUrl,
    baseBranch: entry.baseBranch,
    subdirectory: entry.subdirectory,
    isPrimary: entry.isPrimary,
  }))

export interface RunBootstrapOptions {
  readonly envelope: WorkflowJobEnvelope
  readonly archives: BundleArchiveStore
  /** `SISYPHUS_BUNDLES_BUCKET`. Instance configuration, never the envelope's. */
  readonly bundlesBucket: string
  /** `SISYPHUS_WORKSPACE_ROOT` — the pinned root (FR-051, R2). */
  readonly workspaceRoot: string
  readonly reporter: BootstrapPhaseReporter
  readonly adapter: AgentAdapter
  /** `machine.fetchAgentCredential`, for phase 5a (003/FR-012, FR-049). */
  readonly credentials: AgentCredentialSource
  /**
   * The run's known-value redaction set (003/FR-014).
   *
   * Phase 5a registers the leased material in it before writing the material anywhere, so the
   * output pipeline knows the value from the moment this process does.
   */
  readonly credentialSecrets: SecretRegistry
  /** Credentials already known, for known-value redaction of setup output (FR-072, FR-089). */
  readonly secrets?: readonly KnownSecret[]
  /** Sanitised setup output as it is produced, for the live panel (FR-046). */
  readonly onSetupOutput?: (text: SanitisedText) => void
  /** Recorded per entry as it lands, so a later failure still names the earlier commits (FR-114). */
  readonly onEntryCheckedOut?: (entry: CheckedOutEntry) => void | Promise<void>
  /** Where the bundle is unpacked. Defaults to a sibling of the workspace root. */
  readonly bundleDir?: string
  readonly timeouts?: Partial<Record<BootstrapPhaseName, number>>
  /** Injected in tests so durations are measured rather than slept through. */
  readonly now?: () => number
  /** Injected in tests; phase 6 shells out to `git` otherwise. */
  readonly env?: Readonly<Record<string, string>>
}

export interface BootstrappedRun {
  readonly bundle: BundleBootstrapResult
  /**
   * The seat this boot installed. **Identifiers and a path, never the material** (003/FR-012).
   *
   * Carried out of bootstrap because the fence is what `credential/rotation-watch.ts` must present
   * on every write-through, and the fetch is the only thing that knows it.
   */
  readonly credential: InstalledAgentCredential
  readonly workspace: ReadyWorkspace
  readonly agent: StartedAgent
  /** Where every skill is resolved from, and nowhere else (FR-110). */
  readonly source: SkillSource
}

/** The unpack target, kept out of the workspace so it is never inside a snapshot. */
export const DEFAULT_BUNDLE_SUBDIRECTORY = '.setup-bundle'

/**
 * Bounds on the credential scan below.
 *
 * Not a judgement about content. Every registered value is expanded into every encoding
 * `output/secret-encodings.ts` can derive and then matched against every chunk of agent output, so
 * the cost of the scan is paid on every byte of the run's log rather than once here. A directory
 * that exceeds any of these is not the `credentials/` directory `contracts/setup-bundle.md`
 * describes, and reading it as one would make redaction the most expensive thing in the pipeline.
 */
export const BUNDLE_CREDENTIAL_SCAN_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 64 * 1024,
  maxDepth: 4,
} as const

export interface BundleCredentialScan {
  /** Files read. */
  readonly files: number
  /** Values registered, counted before the registry deduplicated them. */
  readonly values: number
  /** Files passed over for being too large, or binary. */
  readonly skipped: number
  /** Paths that exist and could not be read, relative to the credential directory. */
  readonly unreadable: readonly string[]
  /** Set when the scan itself failed, rather than one file within it. */
  readonly failure?: string
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined
  }

  return undefined
}

/**
 * **Everything the bundle installed at phase 5, handed to the run's redactor (T239, T231, FR-072,
 * FR-089, 003/FR-014).**
 *
 * `createSecretRegistry` gave the run a set of known values that can grow after the sanitisers were
 * built, and the agent's own credential grows it — at `credential_install` and at every rotation.
 * The **client's** credentials grew it not at all: `assembleRun` passes no `secrets` and
 * `RunExecutorOptions.secrets` is an array snapshotted before bootstrap, so a value installed at
 * phase 5 structurally cannot be in it. The registry was therefore empty of exactly the credentials
 * FR-072 is about, and the only thing between a client's repository-host token and the log the panel
 * streams was pattern matching — which by construction catches formats somebody anticipated, and a
 * client-authored bundle is the case where nobody did.
 *
 * This is the seeding, done **where the values become knowable** rather than where the task that
 * asked for it expected them: at the end of phase 5, against the registry `runExecutor` already
 * threads in for phase 5a. Nothing about it is knowable at assembly time — see `./assemble.ts`.
 *
 * ## It reads the directory rather than being told what is in it
 *
 * `contracts/setup-bundle.md` gives the bundle `credentials/` and says only "whatever setup.sh
 * needs". There is no manifest of installed values and inventing one would be a contract change
 * every bundle already in a client's hands would fail — the argument `./forge-credential.ts` makes
 * at length about not inventing a file name. So the values are read back off the disk the bundle
 * just wrote to, and `output/bundle-secrets.ts` does the guessing about which strings in them are
 * credentials.
 *
 * ## What it deliberately does not cover
 *
 * A bundle that installs a credential **outside** the pinned root — a git helper writing
 * `~/.git-credentials`, a keyring, an environment variable exported into a shell — is not read
 * here, and reading the whole file system to find it would be both unbounded and a way for a test
 * to register the developer's own credentials. Nor does it protect `setup.sh`'s own output *during*
 * phase 5: a script that echoes its token is redacted by the pattern stage alone, because the value
 * is not knowable until the script that installs it has finished. What this closes is the long tail
 * that follows — every line the agent, git and the delivery steps write for the rest of the run.
 *
 * ## It cannot fail the run
 *
 * A credential directory that cannot be read is reported and skipped rather than raised. This is a
 * defence-in-depth layer over a pattern stage that still runs; failing bootstrap here would take
 * runs that work today and stop them, which is a larger harm than the one it would prevent.
 *
 * @param options - The pinned workspace root, and the registry every redaction site reads.
 * @returns What was read and what was registered, for the note the caller writes to the log.
 */
export const registerBundleCredentials = async (options: {
  readonly workspaceRoot: string
  readonly secrets: SecretRegistry
}): Promise<BundleCredentialScan> => {
  const root = agentCredentialDir(options.workspaceRoot)
  const unreadable: string[] = []
  let files = 0
  let values = 0
  let skipped = 0

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (
      depth > BUNDLE_CREDENTIAL_SCAN_LIMITS.maxDepth ||
      files >= BUNDLE_CREDENTIAL_SCAN_LIMITS.maxFiles
    ) {
      return
    }

    let entries: Dirent[]

    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      // A bundle that installs no credentials at all is ordinary — the directory is created by
      // phase 5a, which has not run yet — so its absence is not worth a line in anybody's log.
      if (errorCode(error) !== 'ENOENT') {
        unreadable.push(relative(root, directory) || '.')
      }

      return
    }

    for (const entry of entries) {
      if (files >= BUNDLE_CREDENTIAL_SCAN_LIMITS.maxFiles) {
        return
      }

      const path = join(directory, entry.name)

      if (entry.isDirectory()) {
        await walk(path, depth + 1)

        continue
      }

      // The agent's own login is the platform's, not the bundle's, and phase 5a registers it under
      // its own name. On a resumed instance last boot's copy is still on this disk; registering it
      // a second time under a bundle name would mislabel the placeholder an operator reads.
      if (!entry.isFile() || entry.name === AGENT_CREDENTIAL_FILE_NAME) {
        continue
      }

      let bytes: Buffer

      try {
        bytes = await readFile(path)
      } catch {
        unreadable.push(relative(root, path))

        continue
      }

      files += 1

      // A key store, an archive, a binary blob: nothing with fields to find, and decoding it as
      // UTF-8 would produce replacement characters rather than values.
      if (bytes.byteLength > BUNDLE_CREDENTIAL_SCAN_LIMITS.maxFileBytes || bytes.includes(0)) {
        skipped += 1

        continue
      }

      for (const secret of bundleCredentialSecrets({
        relativePath: relative(root, path),
        text: bytes.toString('utf8'),
      })) {
        options.secrets.add(secret)
        values += 1
      }
    }
  }

  await walk(root, 0)

  return { files, values, skipped, unreadable }
}

/**
 * One line of log saying what the run's redactor now knows — and never a value.
 *
 * Written on every boot, including the boot that found nothing, because "the bundle installed no
 * credential this run knows about" is the condition under which the log is protected by pattern
 * matching alone and an operator reading a leak afterwards should be able to see that it held.
 *
 * @param scan - What {@link registerBundleCredentials} read.
 * @param directory - The credential directory, relative to the workspace root.
 */
export const bundleCredentialNote = (scan: BundleCredentialScan, directory: string): string => {
  const trailer = [
    ...(scan.skipped === 0 ? [] : [`${String(scan.skipped)} skipped as too large or not text`]),
    ...(scan.unreadable.length === 0 ? [] : [`${scan.unreadable.join(', ')} could not be read`]),
  ]
  const suffix = trailer.length === 0 ? '' : ` (${trailer.join('; ')})`

  if (scan.failure !== undefined) {
    return (
      `[bundle] ${directory} could not be examined, so whatever the setup bundle installed is ` +
      `known to this run’s log only by the shape of it (FR-072, FR-089): ${scan.failure}\n`
    )
  }

  if (scan.values === 0) {
    return (
      `[bundle] no credential values were found under ${directory}, so anything the setup bundle ` +
      `installed is known to this run’s log only by the shape of it (FR-072, FR-089)${suffix}\n`
    )
  }

  const one = scan.values === 1

  return (
    `[bundle] ${String(scan.values)} value${one ? '' : 's'} the setup bundle installed under ` +
    `${directory} (${String(scan.files)} file${scan.files === 1 ? '' : 's'}) ` +
    `${one ? 'is' : 'are'} now known to this run’s redactor and will be removed from this run’s ` +
    `output wherever ${one ? 'it appears' : 'they appear'} (FR-072)${suffix}\n`
  )
}

/**
 * Run bootstrap phases 2 through 7, including 5a on every boot (003/FR-050).
 *
 * @param options - The envelope, the object store, the phase reporter, the agent adapter and the
 *   machine surface's credential fetch.
 * @returns The bundle result, the installed seat's identifiers, the checked-out workspace, the
 *   started agent and the skill source.
 * @throws {BootstrapPhaseError} Naming the phase that failed, and — for phase 6 — the entry
 *   (FR-112, FR-146). No path out of this function produces a failure without a phase attached.
 */
export const bootstrapRun = async (options: RunBootstrapOptions): Promise<BootstrappedRun> => {
  const { envelope, workspaceRoot } = options

  // Before phases 2–5, not as part of them: `setup.sh` is promised
  // `SISYPHUS_AGENT_CONFIG_DIR` and writes credential material into it.
  await prepareWorkspaceRoot(workspaceRoot)

  const bundle = await runBundleBootstrap({
    bundle: setupBundleReference(envelope.setupBundle, options.bundlesBucket),
    store: options.archives,
    reporter: options.reporter,
    bundleDir: options.bundleDir ?? join(workspaceRoot, DEFAULT_BUNDLE_SUBDIRECTORY),
    workspaceRoot,
    agentConfigDir: agentConfigDir(workspaceRoot),
    workflowId: envelope.workflowId,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.onSetupOutput === undefined ? {} : { onOutput: options.onSetupOutput }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  // Phase 5's residue, and the moment it becomes possible (T239, FR-072). `setup.sh` has just
  // finished, so whatever credentials this client's bundle installs are now on the disk; before it
  // ran there was nothing to read and no array taken at assembly time could have held them. Not a
  // phase of its own: it reports no outcome, it cannot fail the run, and inserting a step into
  // `BOOTSTRAP_PHASES` would change a table the control plane and the panel both read.
  const scan = await registerBundleCredentials({
    workspaceRoot,
    secrets: options.credentialSecrets,
  }).catch(
    (error: unknown): BundleCredentialScan => ({
      files: 0,
      values: 0,
      skipped: 0,
      unreadable: [],
      failure: error instanceof Error ? error.message : String(error),
    }),
  )

  options.onSetupOutput?.(
    sanitise(
      bundleCredentialNote(scan, relative(workspaceRoot, agentCredentialDir(workspaceRoot))),
      {
        // Through the registry it just seeded: the note names files and counts, never values, and
        // sanitising it anyway means there is no line in this module exempt from the pipeline.
        secrets: options.credentialSecrets.current,
      },
    ),
  )

  // Phase 5a. Unconditional — see the module note: this is the only boot path there is, so a
  // restore boot and a resumed-instance boot reach this line exactly as a first boot does
  // (003/FR-050).
  const credential = await installAgentCredential({
    source: options.credentials,
    workspaceRoot,
    reporter: options.reporter,
    secrets: options.credentialSecrets,
    ...(options.timeouts?.credential_install === undefined
      ? {}
      : { timeoutMs: options.timeouts.credential_install }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const workspace = await checkoutWorkspace({
    root: workspaceRoot,
    entries: workspaceEntries(envelope),
    reporter: options.reporter,
    ...(options.timeouts?.entry_checkout === undefined
      ? {}
      : { timeoutMs: options.timeouts.entry_checkout }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onEntryCheckedOut === undefined ? {} : { reportEntry: options.onEntryCheckedOut }),
  })

  const agent = await startAgentPhase({
    adapter: options.adapter,
    workspace,
    sessionId: envelope.sessionId,
    model: envelope.job.model,
    // Fully assembled upstream; the executor never composes a prompt (FR-162).
    prompt: envelope.prompt.assembled,
    ...(envelope.job.turnCap === null ? {} : { turnCap: envelope.job.turnCap }),
    ...(envelope.job.spendCap === null ? {} : { spendCapUsd: Number(envelope.job.spendCap) }),
    // The **snapshot's** session id, never this run's (FR-150).
    ...(envelope.resumeFromSnapshot === undefined
      ? {}
      : { resumeSessionId: envelope.resumeFromSnapshot.sessionId }),
    reporter: options.reporter,
    ...(options.timeouts?.agent_start === undefined
      ? {}
      : { timeoutMs: options.timeouts.agent_start }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return { bundle, credential, workspace, agent, source: primarySkillSource(workspace) }
}
