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

import { join } from 'node:path'

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
  checkoutWorkspace,
  installAgentCredential,
  prepareWorkspaceRoot,
  runBundleBootstrap,
  startAgentPhase,
} from '../bootstrap'
import type { EnvelopeSetupBundle, WorkflowJobEnvelope } from '../job-envelope'
import type { KnownSecret, SanitisedText, SecretRegistry } from '../output'
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
