import type {
  DescribeInstancesCommandOutput,
  RunInstancesCommandInput,
  RunInstancesCommandOutput,
  TerminateInstancesCommandOutput,
} from '@aws-sdk/client-ec2'
import {
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2'
import type { ComputeLease } from '@bluetel-ai/sisyphus-api/db'

/**
 * The compute seam — what the control plane needs from EC2, and nothing else (T054).
 *
 * Three operations, because three is what the platform actually does with instances: it launches
 * one per admitted workflow (FR-036), it destroys one at teardown (FR-038), and it enumerates the
 * ones it believes it owns so the reconciler can sweep both directions (FR-039). Every other verb
 * the SDK offers is absent on purpose — an interface with a method per API call is a re-export, not
 * a seam, and would put the control plane back to needing real capacity to be testable.
 *
 * The adapter here never constructs a client. It is handed one, which is what lets every test in
 * this app run against a stub sender or against {@link createFakeComputeProvisioner} without an
 * account, a region or a credential anywhere in the process.
 */

/** Tag carried by every instance the platform launches, and the key the sweep matches on. */
export const WORKFLOW_ID_TAG = 'sisyphus:workflow-id'

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

export interface ComputeProvisioner {
  /** Launch one instance for one workflow. Resolves once EC2 has accepted the request. */
  readonly launch: (request: LaunchComputeRequest) => Promise<LaunchedCompute>
  /** Destroy an instance. Idempotent: terminating an already-terminated instance is not an error. */
  readonly terminate: (input: { readonly instanceId: string }) => Promise<void>
  /**
   * Every non-terminated instance carrying {@link WORKFLOW_ID_TAG}. The FR-039 sweep compares this
   * against the live leases in both directions, so it must list instances the database has never
   * heard of — which is why it filters on the tag's presence rather than on a list of ids.
   */
  readonly listWorkflowInstances: () => Promise<readonly WorkflowInstance[]>
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
  send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>
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

    terminate: async (input) => {
      await client.send(new TerminateInstancesCommand({ InstanceIds: [input.instanceId] }))
    },

    listWorkflowInstances: async () => {
      const instances: WorkflowInstance[] = []
      let nextToken: string | undefined

      do {
        const output: DescribeInstancesCommandOutput = await client.send(
          new DescribeInstancesCommand({
            Filters: [
              { Name: `tag-key`, Values: [WORKFLOW_ID_TAG] },
              {
                Name: 'instance-state-name',
                Values: ['pending', 'running', 'shutting-down', 'stopping', 'stopped'],
              },
            ],
            NextToken: nextToken,
          }),
        )

        for (const reservation of output.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            if (instance.InstanceId === undefined) {
              continue
            }
            instances.push({
              instanceId: instance.InstanceId,
              workflowId: instance.Tags?.find((tag) => tag.Key === WORKFLOW_ID_TAG)?.Value,
              state: instance.State?.Name ?? 'unknown',
            })
          }
        }

        nextToken = output.NextToken
      } while (nextToken !== undefined)

      return instances
    },
  }
}
