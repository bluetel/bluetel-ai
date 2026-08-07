/**
 * **Turning an envelope and an environment into a runnable executor (T173, FR-203).**
 *
 * `main.ts` is the process — argv, stdin, signals, exit code. This is everything it would
 * otherwise have to do inline, extracted so it can be exercised: an assembly that can only be run
 * by launching an instance is an assembly nobody checks, which is the condition FR-203 was written
 * against in the first place.
 *
 * Two things it deliberately does not do.
 *
 * **It does not read `process.env`.** The environment arrives as {@link ExecutorEnvironment},
 * validated by `env.ts` and passed in. That keeps this module testable and keeps the one
 * import-time validation site in one place, which is where a missing bucket name should fail.
 *
 * **It does not read the platform credential from anywhere but the envelope.** `scopedCredential`
 * is workflow-scoped and short-lived (FR-037), and it is held in a closure that
 * {@link AssembledRun.useCredential} can replace after a renewal — so a renewal is picked up by the
 * next request without rebuilding the client, and the value never becomes a field anything else
 * can read off a shared object.
 *
 * ## Two credentials, two boundaries, and they must not be confused
 *
 * The envelope's `scopedCredential` authenticates this run to the **machine surface** and nowhere
 * else. The **code host** is a third party and is never shown it. Its credential belongs to the
 * setup bundle (FR-075) and is read from git by `./forge-credential.ts`, lazily, because it does
 * not exist on the instance until bootstrap phase 5 (`setup_script`) has run — long after this
 * function returns. That is why {@link AssembledRun.forge} can be built here at all: the client is
 * constructed with an *accessor*, and nothing resolves until a delivery step asks.
 */

import type { AgentAdapter, FrameTap } from '../agent'
import {
  createAgentDeveloperPort,
  createCliStreamAdapter,
  createFrameTap,
  observeAgentFrames,
} from '../agent'
import type { Forge } from '../delivery'
import { createHttpForge } from '../delivery'
import type { WorkflowJobEnvelope } from '../job-envelope'
import { primaryEntry } from '../job-envelope'
import type { MachineSurfaceClient } from '../report'
import { createHttpMachineTransport, createMachineSurfaceClient } from '../report'
import type { ShutdownRegistry } from '../runtime'
import { createSnapshotWriter } from '../session'
import type { S3Operations } from '../storage'
import {
  createS3BundleArchiveStore,
  createS3Operations,
  createS3SegmentStore,
  createS3SnapshotStore,
} from '../storage'

import { workspaceEntries } from './bootstrap'
import { prepareDeliveryEntries } from './delivery-entries'
import type { RunExecutorOptions, WorkflowPortsFactory } from './execute'
import type { CredentialFiller, ForgeCredential } from './forge-credential'
import { createForgeCredential } from './forge-credential'

/** The instance-level environment, already validated by `env.ts`. */
export interface ExecutorEnvironment {
  readonly region: string
  /** The instance-level fallback. The envelope's `machineSurfaceUrl` takes precedence. */
  readonly machineSurfaceUrl: string
  /**
   * `SISYPHUS_FORGE_API_URL` — the base of the code host's REST API.
   *
   * Instance configuration rather than envelope configuration, and it is not a boundary violation:
   * it is a URL, it is the same for every run on this stage, and it names a service rather than
   * granting access to one. The credential that goes with it is emphatically *not* here; see
   * `./forge-credential.ts`.
   */
  readonly forgeApiUrl: string
  readonly bundlesBucket: string
  readonly logsBucket: string
  readonly snapshotsBucket: string
  readonly workspaceRoot: string
}

/**
 * **The ports this executor does not yet have, stated rather than stubbed.**
 *
 * The delegated type is no longer on this list — see {@link agentWorkflowPorts}. What remains
 * missing is the rest of the agent boundary:
 *
 * - **`ReviewerPort`, `IntegrationPlanner` and `IntegrationPort`**, which ask the running agent to
 *   follow a skill and read a structured answer back for the review and autonomous types.
 * - **A findings publisher and a ticket connector**, for the same two.
 *
 * Returning nothing is the honest expression of that. `dispatchWorkflow` halts naming the workflow
 * type, `runExecutor` reports terminal `failed` with that reason (FR-056), and the run is
 * diagnosable from the panel. The alternative — a stub that returns a plausible proposal — would
 * produce a run that reported success having done nothing, which is strictly worse than a run that
 * says what it is missing.
 */
export const noWorkflowPorts: WorkflowPortsFactory = () => ({})

export interface AgentWorkflowPortsOptions {
  /** The tap on the run's own frame consumer; see `agent/frame-tap.ts`. */
  readonly frames: FrameTap
  /** The code host, already built with its lazy credential accessor. */
  readonly forge: Forge
}

/**
 * **The delegated type's ports, over the running agent and the code host (T194, T195, T230).**
 *
 * This is the factory that makes quickstart Scenario 2 executable. It is a factory rather than a
 * value because both of its halves are built *from* the checked-out workspace, which does not
 * exist until bootstrap phase 6.
 *
 * Three things about it are load-bearing.
 *
 * **The developer port reads the frames the run is already consuming.** `runExecutor` is the single
 * consumer of the agent's output — it turns every frame into a log segment — so the port watches
 * through a tap rather than taking a second iterator. Two iterators over one stream would not split
 * it, they would corrupt it.
 *
 * **The developer port is wrapped, and the wrap is not optional.** `delivery.observing` is the only
 * seam between "the agent stopped changing things" and "`openPullRequestSet` reads `wasChanged`".
 * Unwrapped, the first `wasChanged` read throws naming the defect — which is the right failure,
 * because a silent `false` would open no pull request and discard a successful pass in silence.
 *
 * **`readyForReview` is not passed, and that is FR-060.** Draft is the default and the envelope
 * carries no override today, so a delegated run opens a draft and delivery ownership stays with the
 * engineer who launched it.
 */
export const agentWorkflowPorts =
  ({ frames, forge }: AgentWorkflowPortsOptions): WorkflowPortsFactory =>
  async (context) => {
    const delivery = await prepareDeliveryEntries({
      checkouts: context.bootstrapped.workspace.entries,
      repositories: workspaceEntries(context.envelope),
      forge,
    })

    return {
      delegated: {
        developer: delivery.observing(
          createAgentDeveloperPort({ agent: context.bootstrapped.agent.adapter, frames }),
        ),
        entries: delivery.entries,
        // The durable ledger, never a fresh Map: the difference is invisible here and the cost of
        // getting it wrong is a second pull request on a customer's repository (FR-077).
        pullRequestLedger: context.ledgers.pullRequest,
        secrets: context.secrets,
      },
    }
  }

export interface AssembleRunOptions {
  readonly envelope: WorkflowJobEnvelope
  readonly environment: ExecutorEnvironment
  readonly shutdown: ShutdownRegistry
  /**
   * Defaults to {@link agentWorkflowPorts} — the real developer port and the real forge.
   *
   * Pass {@link noWorkflowPorts} to assert the halt path, and a fake to test a workflow without an
   * agent. The default is deliberately the working one: a default that halted would mean the
   * production path was whichever caller remembered to override it.
   */
  readonly ports?: WorkflowPortsFactory
  /** Injected in tests, so no assembly opens a socket. */
  readonly operations?: S3Operations
  /** Injected in tests; a deployed instance spawns the agent CLI. */
  readonly adapter?: AgentAdapter
  /** Injected in tests, so no assembly spawns `git credential fill`. */
  readonly fillCredential?: CredentialFiller
  readonly onReportingFailure?: (error: unknown, detail: string) => void
}

export interface AssembledRun {
  readonly options: RunExecutorOptions
  readonly client: MachineSurfaceClient
  /** Replace the workflow-scoped credential after a renewal (FR-037). */
  readonly useCredential: (credential: string) => void
  /**
   * The code host, ready to use (FR-060, FR-077).
   *
   * Held here rather than on {@link RunExecutorOptions} because the delivery path receives it
   * through the workflow ports, which are built from the checked-out workspace and are not this
   * function's to assemble. Exposing it is what lets the port factory that eventually wires
   * `DeveloperPort` take a forge it did not build — and never a credential.
   */
  readonly forge: Forge
  /**
   * The accessor the forge was built with, for anything else that needs the same credential.
   *
   * Resolves on first use and not before: the value does not exist until bootstrap phase 5. See
   * `./forge-credential.ts` — the value itself is never readable off this object.
   */
  readonly forgeCredential: ForgeCredential
}

/**
 * Build everything one run needs.
 *
 * @param options - The parsed envelope, the validated environment and the shutdown registry.
 * @returns The `runExecutor` options, plus the machine-surface client for the caller to reuse.
 */
export const assembleRun = (options: AssembleRunOptions): AssembledRun => {
  const { envelope, environment } = options
  let credential = envelope.scopedCredential

  const operations = options.operations ?? createS3Operations({ region: environment.region })

  const client = createMachineSurfaceClient({
    workflowId: envelope.workflowId,
    transport: createHttpMachineTransport({
      // The envelope's URL wins: it is the one the credential was minted against. The environment
      // carries a fallback only so a boot that fails before the envelope is parsed can still speak.
      url: envelope.machineSurfaceUrl || environment.machineSurfaceUrl,
      credential: () => credential,
    }),
  })

  // The primary entry's remote, because the forge API base is one URL for the whole instance and
  // therefore names one host — and the primary entry is the run's own repository (FR-110). A
  // workspace spanning two hosts would need a forge per host, which is a change to the port
  // selection rather than to this line.
  const forgeCredential = createForgeCredential({
    repositoryUrl: primaryEntry(envelope).repositoryUrl,
    ...(options.fillCredential === undefined ? {} : { fill: options.fillCredential }),
  })

  const forge = createHttpForge({
    apiBaseUrl: environment.forgeApiUrl,
    credential: forgeCredential.read,
  })

  // One tap, wrapping the adapter before anything else sees it. `runExecutor` stays the single
  // consumer of the frame stream — it writes every frame to a log segment — and the developer port
  // watches what that consumer pulls. A second iterator over one stream corrupts it rather than
  // splitting it, which is why this is a tap and not a second `subscribe`.
  const frames = createFrameTap()
  const adapter = observeAgentFrames(options.adapter ?? createCliStreamAdapter(), frames)

  return {
    client,
    useCredential: (next: string) => {
      credential = next
    },
    forgeCredential,
    // Constructed, not resolved. `createHttpForge` calls the accessor per request, so building
    // this before phase 5 costs nothing and reads nothing.
    forge,
    options: {
      envelope,
      client,
      archives: createS3BundleArchiveStore({
        operations,
        bucket: environment.bundlesBucket,
      }),
      segments: createS3SegmentStore({ operations, bucket: environment.logsBucket }),
      snapshots: createSnapshotWriter({
        store: createS3SnapshotStore({ operations, bucket: environment.snapshotsBucket }),
        bucket: environment.snapshotsBucket,
        workflowId: envelope.workflowId,
      }),
      adapter,
      ports: options.ports ?? agentWorkflowPorts({ frames, forge }),
      bundlesBucket: environment.bundlesBucket,
      workspaceRoot: environment.workspaceRoot,
      shutdown: options.shutdown,
      ...(options.onReportingFailure === undefined
        ? {}
        : { onReportingFailure: options.onReportingFailure }),
    },
  }
}

/**
 * A validation run this executor cannot yet serve (FR-147).
 *
 * The mode is parsed, because refusing an envelope shape the control plane can legitimately send
 * is better done at the boundary with a sentence than three phases in with a type error. What is
 * missing is the reporting half: a validation run reports to `validationRuns` rather than to a
 * workflow row, and no procedure for that is mounted on the machine surface this executor talks
 * to. Until one is, a validation envelope halts here rather than being run as a workflow.
 */
export const validationModeUnsupportedError = (): Error =>
  new Error(
    'this instance was launched with a validation-mode job envelope (FR-147). Bootstrap phases ' +
      '2–5 are implemented, but a validation run reports against the bundle version rather than ' +
      'a workflow row and the machine surface exposes no procedure for that, so there is nowhere ' +
      'for the result to go. Nothing was attempted.',
  )
