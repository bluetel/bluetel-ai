import type {
  DescribeInstancesCommandOutput,
  DescribeVolumesCommandOutput,
  InstanceStateChange,
  RunInstancesCommandInput,
  RunInstancesCommandOutput,
  StartInstancesCommandOutput,
  StopInstancesCommandOutput,
  TerminateInstancesCommandOutput,
} from '@aws-sdk/client-ec2'
import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2'
import type { ComputeLease } from '@bluetel-ai/sisyphus-api/db'

/**
 * The compute seam — what the control plane needs from EC2, and nothing else (T054, T072, T092).
 *
 * Eight operations, because eight is what the platform actually does with instances: it launches
 * one per admitted workflow (FR-036), it launches a **login environment** that belongs to no
 * workflow at all (003/FR-069), it destroys either kind (FR-038, 003/FR-071), it enumerates each
 * kind separately so the reconciler and the login reaper can sweep their own populations (FR-039,
 * 003/FR-071), and — since 003/FR-039 — it **stops** and **starts** a workflow instance and reads
 * back the volumes still attached to it. Every other verb the SDK offers is absent on purpose — an
 * interface with a method per API call is a re-export, not a seam, and would put the control plane
 * back to needing real capacity to be testable.
 *
 * ## Stop and start are what pause and resume are made of (003/FR-039, FR-041)
 *
 * 002 paused a run by holding the agent process alive on a running instance, which billed for
 * compute nobody was using. 003 replaces that with a real stop: the disk survives, the instance
 * does not bill, and a resume is `StartInstances` against the *same* instance rather than a fresh
 * launch and a restore. {@link ComputeProvisioner.describeVolumes} is how "the disk survives" stops
 * being an assumption — it is the observation a pause makes and records.
 *
 * **{@link ComputeProvisioner.stop} applies to on-demand capacity only, and this seam does not
 * enforce that.** A one-time spot instance cannot be stopped by its owner at all; EC2 refuses the
 * call. Which purchase modes may be stopped is a decision about a *workflow*, taken with the lease
 * in hand, so it lives in `jobs/pause-instance.ts` where the lease is. Putting it here would make
 * the adapter refuse a call EC2 is perfectly willing to accept for a persistent spot request, which
 * is a door 003 research R6 deliberately left open.
 *
 * The adapter here never constructs a client. It is handed one, which is what lets every test in
 * this app run against a stub sender or against {@link createFakeComputeProvisioner} without an
 * account, a region or a credential anywhere in the process.
 *
 * ## The two instance populations are disjoint, and that is a safety property
 *
 * A workflow instance carries {@link WORKFLOW_ID_TAG}. A login instance carries
 * {@link CREDENTIAL_LOGIN_TAG} and **never** {@link WORKFLOW_ID_TAG}. Both list operations filter
 * on the presence of their own tag key, so the two sets cannot overlap and neither can see the
 * other's members — which is how 003/FR-071's "not reachable by any workflow while it exists"
 * becomes a fact about the tag space rather than a rule somebody has to remember.
 *
 * The alternative — one tag key with a `login:` prefix, as `jobs/instance-tag.ts` does for bundle
 * validation runs — was rejected here. It would put login instances inside
 * {@link ComputeProvisioner.listWorkflowInstances}, which is the set the FR-039 sweep walks when it
 * decides what to terminate and which lease a live instance belongs to. A login environment has no
 * lease, no workflow row and no heartbeat, so every sweep would have to be taught to skip it, and
 * the day one of them was not, the sweep would terminate an administrator's half-finished login as
 * a leak. Keeping the populations in separate tag spaces means there is nothing to teach.
 */

/** Tag carried by every **workflow** instance the platform launches, and the key the sweep matches on. */
export const WORKFLOW_ID_TAG = 'sisyphus:workflow-id'

/**
 * Tag carried by every **login** instance, holding the agent credential the login is for
 * (003/FR-069).
 *
 * A different key from {@link WORKFLOW_ID_TAG} rather than a different value under it. See the
 * module note: the separation is what makes a login environment invisible to every path that maps
 * instances onto workflows.
 */
export const CREDENTIAL_LOGIN_TAG = 'sisyphus:credential-login'

/**
 * Tag holding the wall-clock instant after which a login instance is reaped, as an ISO-8601 string
 * (003/FR-071).
 *
 * On the instance rather than only in the platform's memory, because the reaper's whole purpose is
 * the case where nothing is watching: an administrator closes the tab and no completion event is
 * ever produced. A deadline that lived only in a process would be lost with that process, and the
 * instance would bill until somebody noticed it. Written where the sweep can read it back, the
 * deadline survives every restart the platform can have.
 */
export const LOGIN_EXPIRES_AT_TAG = 'sisyphus:login-expires-at'

/** Tag carried alongside it, so an instance is identifiable in the console without a lookup. */
export const NAME_TAG = 'Name'

export interface LaunchComputeRequest {
  readonly workflowId: string
  /** From the workflow's write-once job spec, never from a default here. */
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
  /**
   * The job envelope, already assembled by the caller (T052). Passed through verbatim and
   * base64-encoded by the adapter; this seam does not know what is in it and must not, because
   * FR-036 makes the envelope's contents the provisioning job's responsibility.
   */
  readonly userData: string
}

export interface LaunchedCompute {
  readonly instanceId: string
  readonly instanceType: string
  readonly purchaseMode: ComputeLease['purchaseMode']
}

/** What the reconciler needs to know about an instance: which run owns it, and whether it lives. */
export interface WorkflowInstance {
  readonly instanceId: string
  /** Undefined when the tag is missing — an instance the platform launched but cannot attribute. */
  readonly workflowId: string | undefined
  /** The EC2 lifecycle name as reported, e.g. `pending`, `running`, `shutting-down`. */
  readonly state: string
}

/**
 * Launch one ephemeral login environment (003/FR-069).
 *
 * **There is no `workflowId` on this request, and there is no way to add one.** That is the whole
 * of the isolation requirement expressed as a type: a login environment is not a run, holds no
 * lease and belongs to no workflow, so the field a caller would need in order to attach one to a
 * run does not exist.
 *
 * There is no `purchaseMode` either. A login is an interactive session with a person waiting at the
 * other end of it, and interruptible capacity that vanishes mid-login would cost the administrator
 * the whole attempt to save a few pence for a few minutes.
 */
export interface LaunchLoginRequest {
  /** The seat this login is for. Becomes {@link CREDENTIAL_LOGIN_TAG}. */
  readonly agentCredentialId: string
  readonly instanceType: string
  /**
   * When the reaper may destroy this instance regardless of what the administrator is doing
   * (003/FR-071). Recorded on the instance as {@link LOGIN_EXPIRES_AT_TAG}.
   */
  readonly expiresAt: Date
  /**
   * Boot script for a **bundle-less, workspace-less** instance carrying only the agent CLI
   * (003/FR-069). Assembled by the caller and passed through verbatim, exactly as
   * {@link LaunchComputeRequest.userData} is; this seam does not know what is in it.
   */
  readonly userData: string
}

export interface LaunchedLoginEnvironment {
  readonly instanceId: string
  readonly agentCredentialId: string
  readonly expiresAt: Date
}

/**
 * What the login reaper needs to know about an instance: which seat it is for, when it stops being
 * allowed to exist, and whether it still lives.
 *
 * `expiresAt` is `undefined` when the tag is missing or cannot be read. The reaper treats that as
 * immediately expired rather than as "no deadline" — see `credentials/login/reaper.ts`. An instance
 * the platform cannot date is an instance nobody is accounting for, and the safe reading of an
 * unaccounted-for interactive box is that it should not be there.
 */
export interface LoginInstance {
  readonly instanceId: string
  /** Undefined when the tag carries no value — an instance that cannot be attributed to a seat. */
  readonly agentCredentialId: string | undefined
  readonly expiresAt: Date | undefined
  /** The EC2 lifecycle name as reported, e.g. `pending`, `running`, `shutting-down`. */
  readonly state: string
}

/**
 * What a stop or a start did, as EC2 reported it (003/FR-039, FR-041).
 *
 * Both states are carried rather than only the new one, because the pair is what makes the call
 * legible after the fact: `running → stopping` is a pause taking effect, and `stopped → stopped` is
 * a retry of a pause that had already landed. A caller given only `currentState` cannot tell those
 * apart, and a pause job that could not tell them apart would either report a no-op as an action or
 * treat an idempotent retry as a failure.
 *
 * `currentState` is the state **at the moment of the call**, not the settled one: `StopInstances`
 * answers `stopping`, and the instance reaches `stopped` some seconds later. Nothing in this
 * codebase waits for that transition inline — see `jobs/pause-instance.ts` for why the pause is
 * complete once EC2 has accepted the stop.
 */
export interface InstanceTransition {
  readonly instanceId: string
  /** The lifecycle name before the call, e.g. `running`. */
  readonly previousState: string
  /** The lifecycle name EC2 moved it to, e.g. `stopping`. */
  readonly currentState: string
}

/**
 * One EBS volume attached to an instance — the disk a pause has to keep (003/FR-039).
 *
 * `deleteOnTermination` is the field that matters and the reason this is not simply a count. It is
 * the difference between an instance whose disk outlives it and one whose disk does not, which is
 * exactly the difference between the two pause paths: an on-demand pause **stops** the instance and
 * the volume is retained whatever this flag says, while the spot path terminates and the flag
 * decides whether anything at all is left behind. A pause that reported "the disk is retained"
 * without ever having looked would be reporting its own intention.
 */
export interface AttachedVolume {
  readonly volumeId: string
  readonly instanceId: string
  /** e.g. `/dev/xvda`. Undefined when EC2 reports an attachment without one. */
  readonly deviceName: string | undefined
  readonly sizeGib: number | undefined
  /** The volume lifecycle name as reported, e.g. `in-use`, `available`. */
  readonly state: string
  /** True when terminating the instance destroys this volume. */
  readonly deleteOnTermination: boolean
}

export interface ComputeProvisioner {
  /** Launch one instance for one workflow. Resolves once EC2 has accepted the request. */
  readonly launch: (request: LaunchComputeRequest) => Promise<LaunchedCompute>
  /**
   * Launch one ephemeral login environment (003/FR-069, 003/FR-071).
   *
   * Separate from {@link ComputeProvisioner.launch} rather than a mode on it, because the two
   * differ in every respect that matters: one carries a job envelope, a workspace and a setup
   * bundle and is attached to a lease, and the other carries none of those and is attached to
   * nothing. A single method with an optional `workflowId` would make "a login instance with a
   * workflow id" a state the type system permits, and the whole point is that it is not.
   */
  readonly launchLogin: (request: LaunchLoginRequest) => Promise<LaunchedLoginEnvironment>
  /** Destroy an instance. Idempotent: terminating an already-terminated instance is not an error. */
  readonly terminate: (input: { readonly instanceId: string }) => Promise<void>
  /**
   * Stop an instance, keeping its root volume (003/FR-039).
   *
   * **This is a control-plane call, and it has to be.** Every instance this seam launches carries
   * `InstanceInitiatedShutdownBehavior: 'terminate'`, so an executor that shut *itself* down would
   * destroy its own disk and turn every pause into a restore. That setting is not an oversight to
   * be tidied up once pause exists — it is what stops a crashed or wedged executor leaking a
   * billable stopped instance that nothing is watching, which is a far more common failure than a
   * pause. So the two live side by side: the instance may never stop itself, and the platform stops
   * it from outside.
   *
   * @throws Whatever EC2 raises. A one-time spot instance cannot be stopped and the call fails with
   *   `UnsupportedOperation`; `jobs/pause-instance.ts` is what knows not to ask, and what to do
   *   about a stop that fails anyway (003/FR-043).
   */
  readonly stop: (input: { readonly instanceId: string }) => Promise<InstanceTransition>
  /**
   * Start a stopped instance again — the whole of a resume (003/FR-041).
   *
   * No launch, no user data, no tags: this is the same instance, with the same disk, the same
   * working tree and the same session on it. What it is *not* is a guarantee. A stopped instance
   * can fail to start — the availability zone has no capacity of that family, or the instance has
   * been retired underneath the platform — and 003/FR-043 is the answer to that, not this method.
   *
   * @throws Whatever EC2 raises. The caller treats a rejection as "recover from the snapshot
   *   instead", which is the one path both this failure and a spot pause converge on.
   */
  readonly start: (input: { readonly instanceId: string }) => Promise<InstanceTransition>
  /**
   * Every volume currently attached to an instance (003/FR-039).
   *
   * The observation behind "stopped with its disk retained". A pause calls this **after** the stop
   * so that what it records is what EC2 says is there, rather than what the pause meant to happen.
   *
   * @returns Empty for an instance that has no attachments or does not exist. A missing instance is
   *   not an error here: `DescribeVolumes` filters, and a filter matching nothing is an empty
   *   answer in every API that has one.
   */
  readonly describeVolumes: (input: {
    readonly instanceId: string
  }) => Promise<readonly AttachedVolume[]>
  /**
   * Every non-terminated instance carrying {@link WORKFLOW_ID_TAG}. The FR-039 sweep compares this
   * against the live leases in both directions, so it must list instances the database has never
   * heard of — which is why it filters on the tag's presence rather than on a list of ids.
   *
   * **Login instances are never in this set.** They carry no {@link WORKFLOW_ID_TAG} at all, so the
   * filter excludes them by construction rather than by a skip somebody has to maintain.
   */
  readonly listWorkflowInstances: () => Promise<readonly WorkflowInstance[]>
  /**
   * Every non-terminated instance carrying {@link CREDENTIAL_LOGIN_TAG} — the login reaper's
   * population, and disjoint from {@link ComputeProvisioner.listWorkflowInstances} by the same
   * construction.
   */
  readonly listLoginInstances: () => Promise<readonly LoginInstance[]>
}

/**
 * The subset of `EC2Client` this adapter uses.
 *
 * Declared as three overloads rather than as `Pick<EC2Client, 'send'>` so a test can supply a
 * plainly-typed stub: the SDK's generic `send` is awkward to implement by hand, and a fake that
 * needs a cast to exist is a fake nobody writes. `EC2Client` satisfies this interface, which
 * `compute.test.ts` asserts at compile time.
 */
export interface Ec2CommandSender {
  send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>
  send(command: TerminateInstancesCommand): Promise<TerminateInstancesCommandOutput>
  send(command: StopInstancesCommand): Promise<StopInstancesCommandOutput>
  send(command: StartInstancesCommand): Promise<StartInstancesCommandOutput>
  send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>
  send(command: DescribeVolumesCommand): Promise<DescribeVolumesCommandOutput>
}

export interface Ec2ComputeConfiguration {
  readonly amiId: string
  readonly instanceProfileArn: string
  /** More than one is the point: spot capacity is per-availability-zone. */
  readonly subnetIds: readonly string[]
  readonly securityGroupIds: readonly string[]
  /** Distinguishes one stage's instances from another's in a shared account. */
  readonly stage: string
}

export interface Ec2ComputeProvisionerOptions {
  readonly client: Ec2CommandSender
  readonly configuration: Ec2ComputeConfiguration
  /**
   * Which subnet a launch lands in. Random by default so repeated launches spread across
   * availability zones; injectable so a test asserting the request shape is not asserting on luck.
   */
  readonly selectSubnet?: (subnetIds: readonly string[]) => string
}

/** Element at an index, honestly typed — `noUncheckedIndexedAccess` is off in this workspace. */
const elementAt = <TItem>(items: readonly TItem[], index: number): TItem | undefined => items[index]

const randomSubnet = (subnetIds: readonly string[]): string => {
  const chosen = elementAt(subnetIds, Math.floor(Math.random() * subnetIds.length))
  if (chosen === undefined) {
    throw new Error(
      'No executor subnets are configured. A launch with no subnet fails inside EC2 with a message about the network interface rather than about the missing configuration.',
    )
  }
  return chosen
}

/** First element, honestly typed — `noUncheckedIndexedAccess` is off in this workspace. */
const firstOf = <TItem>(items: readonly TItem[] | undefined): TItem | undefined => items?.[0]

/** The lifecycle names that mean "this instance still exists and may still be costing money". */
const LIVE_INSTANCE_STATES = ['pending', 'running', 'shutting-down', 'stopping', 'stopped']

/** One instance as EC2 reported it, reduced to the two things both sweeps read. */
interface DescribedInstance {
  readonly instanceId: string
  readonly state: string
  readonly tagValue: (key: string) => string | undefined
}

/**
 * Every live instance carrying `tagKey`, following pagination to the end.
 *
 * Shared by both sweeps so they cannot drift on which lifecycle states count as live. The
 * difference between them is one filter value and how the tags are read back, which is exactly the
 * amount of difference there should be: two populations, one mechanism for enumerating them.
 */
const describeTagged = async (
  client: Ec2CommandSender,
  tagKey: string,
): Promise<readonly DescribedInstance[]> => {
  const described: DescribedInstance[] = []
  let nextToken: string | undefined

  do {
    const output: DescribeInstancesCommandOutput = await client.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: `tag-key`, Values: [tagKey] },
          { Name: 'instance-state-name', Values: LIVE_INSTANCE_STATES },
        ],
        NextToken: nextToken,
      }),
    )

    for (const reservation of output.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.InstanceId === undefined) {
          continue
        }
        const tags = instance.Tags
        described.push({
          instanceId: instance.InstanceId,
          state: instance.State?.Name ?? 'unknown',
          tagValue: (key) => tags?.find((tag) => tag.Key === key)?.Value,
        })
      }
    }

    nextToken = output.NextToken
  } while (nextToken !== undefined)

  return described
}

/**
 * Turn EC2's state-change record into an {@link InstanceTransition}, or fail saying what is missing.
 *
 * `StopInstances` and `StartInstances` both answer with one `InstanceStateChange` per instance
 * asked about, and an answer with none is not a no-op — it is EC2 accepting a request and declining
 * to say what it did. Reporting that as a completed transition is the failure worth guarding
 * against: a pause would record a stop that may not have happened, and the platform would go on
 * believing an instance was not billing while it was.
 *
 * @param changes - `StoppingInstances` or `StartingInstances` from the SDK.
 * @param verb - Named in the error, so the message says which call came back empty.
 * @param instanceId - Named in the error for the same reason.
 */
const transitionOf = (
  changes: readonly InstanceStateChange[] | undefined,
  verb: 'start' | 'stop',
  instanceId: string,
): InstanceTransition => {
  const change = firstOf(changes)

  if (change === undefined) {
    throw new Error(
      `EC2 accepted the ${verb} of instance ${instanceId} but reported no state change for it, so the platform cannot tell whether the instance is ${verb === 'stop' ? 'still billing' : 'coming back'}.`,
    )
  }

  return {
    instanceId: change.InstanceId ?? instanceId,
    previousState: change.PreviousState?.Name ?? 'unknown',
    currentState: change.CurrentState?.Name ?? 'unknown',
  }
}

/**
 * Read {@link LOGIN_EXPIRES_AT_TAG} back into a date.
 *
 * An absent, blank or unreadable tag answers `undefined` rather than throwing. The reaper decides
 * what to do about an instance it cannot date — and it reaps it — so turning a malformed tag into
 * an exception here would take the whole sweep down over one bad instance and leave every other
 * expired login running.
 */
const parseExpiry = (value: string | undefined): Date | undefined => {
  if (value === undefined || value === '') {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * `EC2Client`-backed {@link ComputeProvisioner}.
 *
 * @param options - The client is supplied by the caller; nothing here creates one, so importing
 *   this module never reaches AWS.
 */
export const createEc2ComputeProvisioner = (
  options: Ec2ComputeProvisionerOptions,
): ComputeProvisioner => {
  const { client, configuration } = options
  const selectSubnet = options.selectSubnet ?? randomSubnet

  return {
    launch: async (request) => {
      const output = await client.send(
        new RunInstancesCommand({
          ImageId: configuration.amiId,
          // The SDK types this as a closed union of every instance family it knew about when it
          // was published; the platform stores it as text on the workflow, because a new family
          // must be usable without a dependency bump. The narrowing happens at EC2, which is the
          // only party that actually knows what exists.
          InstanceType: request.instanceType as RunInstancesCommandInput['InstanceType'],
          MinCount: 1,
          MaxCount: 1,
          IamInstanceProfile: { Arn: configuration.instanceProfileArn },
          SubnetId: selectSubnet(configuration.subnetIds),
          SecurityGroupIds: [...configuration.securityGroupIds],
          UserData: Buffer.from(request.userData, 'utf8').toString('base64'),
          // An executor that shuts itself down must not leave a billable stopped instance behind.
          InstanceInitiatedShutdownBehavior: 'terminate',
          ...(request.purchaseMode === 'spot'
            ? { InstanceMarketOptions: { MarketType: 'spot' as const } }
            : {}),
          TagSpecifications: [
            {
              ResourceType: 'instance' as const,
              Tags: [
                { Key: WORKFLOW_ID_TAG, Value: request.workflowId },
                { Key: NAME_TAG, Value: `sisyphus-${configuration.stage}-${request.workflowId}` },
              ],
            },
          ],
        }),
      )

      const instanceId = firstOf(output.Instances)?.InstanceId
      if (instanceId === undefined) {
        throw new Error(
          `EC2 accepted the launch for workflow ${request.workflowId} but returned no instance id, so there is nothing to record on the lease or to terminate later.`,
        )
      }

      return {
        instanceId,
        instanceType: request.instanceType,
        purchaseMode: request.purchaseMode,
      }
    },

    /**
     * Launch the ephemeral login environment (003/FR-069, 003/FR-071).
     *
     * Four things about this request are load-bearing, and each of them is the absence of
     * something the workflow launch above has:
     *
     * **No {@link WORKFLOW_ID_TAG}.** Nothing that maps instances onto runs can see this box. The
     * FR-039 reconciliation sweep filters on that tag key, so a login environment is not in the set
     * it walks, is never compared against a lease, and is never terminated as an unattributed leak
     * while an administrator is halfway through typing a password into it.
     *
     * **No envelope.** `userData` here carries no job, no workspace manifest, no setup bundle and
     * no workflow-scoped credential, because there is no workflow to scope one to. The AMI is the
     * executor's, which already carries the agent CLI — what makes the instance bundle-less and
     * workspace-less is that it is given nothing to fetch or mount, not a different image.
     *
     * **No spot.** A person is waiting at the other end of this instance; interruptible capacity
     * disappearing mid-login would cost them the whole attempt to save pence.
     *
     * **A deadline written onto the instance**, so the reaper can enforce 003/FR-071 against an
     * attempt that produced no completion event at all.
     */
    launchLogin: async (request) => {
      const expiresAt = request.expiresAt.toISOString()

      const output = await client.send(
        new RunInstancesCommand({
          ImageId: configuration.amiId,
          InstanceType: request.instanceType as RunInstancesCommandInput['InstanceType'],
          MinCount: 1,
          MaxCount: 1,
          IamInstanceProfile: { Arn: configuration.instanceProfileArn },
          SubnetId: selectSubnet(configuration.subnetIds),
          SecurityGroupIds: [...configuration.securityGroupIds],
          UserData: Buffer.from(request.userData, 'utf8').toString('base64'),
          InstanceInitiatedShutdownBehavior: 'terminate',
          TagSpecifications: [
            {
              ResourceType: 'instance' as const,
              Tags: [
                { Key: CREDENTIAL_LOGIN_TAG, Value: request.agentCredentialId },
                { Key: LOGIN_EXPIRES_AT_TAG, Value: expiresAt },
                {
                  Key: NAME_TAG,
                  Value: `sisyphus-${configuration.stage}-login-${request.agentCredentialId}`,
                },
              ],
            },
          ],
        }),
      )

      const instanceId = firstOf(output.Instances)?.InstanceId
      if (instanceId === undefined) {
        throw new Error(
          `EC2 accepted the login launch for agent credential ${request.agentCredentialId} but returned no instance id. There is then nothing to relay a session to and, worse, nothing to terminate — an untagged, unreachable instance billing until somebody finds it by hand.`,
        )
      }

      return {
        instanceId,
        agentCredentialId: request.agentCredentialId,
        expiresAt: request.expiresAt,
      }
    },

    terminate: async (input) => {
      await client.send(new TerminateInstancesCommand({ InstanceIds: [input.instanceId] }))
    },

    /**
     * `StopInstances`, from the control plane and never from the instance (003/FR-039).
     *
     * See {@link ComputeProvisioner.stop}: the launch above sets
     * `InstanceInitiatedShutdownBehavior: 'terminate'` and that stays, because it is what keeps a
     * crashed executor from leaving a stopped instance behind for somebody to find on a bill. The
     * consequence is this method — the only way to stop an instance without destroying its disk is
     * to ask from outside it.
     */
    stop: async (input) => {
      const output = await client.send(
        new StopInstancesCommand({ InstanceIds: [input.instanceId] }),
      )
      return transitionOf(output.StoppingInstances, 'stop', input.instanceId)
    },

    start: async (input) => {
      const output = await client.send(
        new StartInstancesCommand({ InstanceIds: [input.instanceId] }),
      )
      return transitionOf(output.StartingInstances, 'start', input.instanceId)
    },

    /**
     * Every volume attached to one instance, following pagination to the end.
     *
     * Filtered on `attachment.instance-id` rather than looked up from the instance description,
     * because the block-device mappings on a `DescribeInstances` answer describe what the instance
     * was *launched* with. What a pause needs to record is what is attached now.
     */
    describeVolumes: async (input) => {
      const volumes: AttachedVolume[] = []
      let nextToken: string | undefined

      do {
        const output: DescribeVolumesCommandOutput = await client.send(
          new DescribeVolumesCommand({
            Filters: [{ Name: 'attachment.instance-id', Values: [input.instanceId] }],
            NextToken: nextToken,
          }),
        )

        for (const volume of output.Volumes ?? []) {
          if (volume.VolumeId === undefined) {
            continue
          }

          const attachment = volume.Attachments?.find(
            (candidate) => candidate.InstanceId === input.instanceId,
          )

          volumes.push({
            volumeId: volume.VolumeId,
            instanceId: input.instanceId,
            deviceName: attachment?.Device,
            sizeGib: volume.Size,
            state: volume.State ?? 'unknown',
            deleteOnTermination: attachment?.DeleteOnTermination ?? false,
          })
        }

        nextToken = output.NextToken
      } while (nextToken !== undefined)

      return volumes
    },

    listWorkflowInstances: async () =>
      (await describeTagged(client, WORKFLOW_ID_TAG)).map((instance) => ({
        instanceId: instance.instanceId,
        workflowId: instance.tagValue(WORKFLOW_ID_TAG),
        state: instance.state,
      })),

    listLoginInstances: async () =>
      (await describeTagged(client, CREDENTIAL_LOGIN_TAG)).map((instance) => ({
        instanceId: instance.instanceId,
        agentCredentialId: instance.tagValue(CREDENTIAL_LOGIN_TAG),
        expiresAt: parseExpiry(instance.tagValue(LOGIN_EXPIRES_AT_TAG)),
        state: instance.state,
      })),
  }
}
