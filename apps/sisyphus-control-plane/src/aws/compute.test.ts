import type {
  DescribeInstancesCommandOutput,
  DescribeVolumesCommandOutput,
  EC2Client,
  RunInstancesCommandOutput,
  StartInstancesCommandOutput,
  StopInstancesCommandOutput,
  TerminateInstancesCommandOutput,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2'
import {
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2'
import { describe, expect, it } from 'vitest'

import type { Ec2CommandSender, Ec2ComputeConfiguration } from './compute'
import {
  CREDENTIAL_LOGIN_TAG,
  createEc2ComputeProvisioner,
  LOGIN_EXPIRES_AT_TAG,
  WORKFLOW_ID_TAG,
} from './compute'

/**
 * The adapter is exercised against a stub sender that records commands and returns canned output.
 * Nothing here constructs an `EC2Client`, reads a region or touches an account — that is the whole
 * claim T054 makes, and a test that needed capacity to run would disprove it.
 */

const metadata = { $metadata: {} }

/**
 * A hand-written `EC2Client` stand-in.
 *
 * A class rather than an object literal because {@link Ec2CommandSender} is declared as overloads,
 * and only a class body can carry an overload set plus its implementation. `sendIsAssignable` below
 * checks the other direction — that a real client still satisfies the interface.
 */
class StubEc2Sender {
  public readonly commands: object[] = []

  public constructor(
    private readonly responses: {
      readonly run?: RunInstancesCommandOutput
      readonly describe?: readonly DescribeInstancesCommandOutput[]
      readonly stop?: StopInstancesCommandOutput
      readonly start?: StartInstancesCommandOutput
      readonly volumes?: readonly DescribeVolumesCommandOutput[]
    } = {},
  ) {}

  private describeCalls = 0

  private volumeCalls = 0

  public send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>
  public send(command: TerminateInstancesCommand): Promise<TerminateInstancesCommandOutput>
  public send(command: StopInstancesCommand): Promise<StopInstancesCommandOutput>
  public send(command: StartInstancesCommand): Promise<StartInstancesCommandOutput>
  public send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>
  public send(command: DescribeVolumesCommand): Promise<DescribeVolumesCommandOutput>
  public send(command: object): Promise<object> {
    this.commands.push(command)

    if (command instanceof RunInstancesCommand) {
      return Promise.resolve(
        this.responses.run ?? { ...metadata, Instances: [{ InstanceId: 'i-1' }] },
      )
    }
    if (command instanceof StopInstancesCommand) {
      return Promise.resolve(
        this.responses.stop ?? {
          ...metadata,
          StoppingInstances: [
            {
              InstanceId: 'i-9',
              PreviousState: { Name: 'running' },
              CurrentState: { Name: 'stopping' },
            },
          ],
        },
      )
    }
    if (command instanceof StartInstancesCommand) {
      return Promise.resolve(
        this.responses.start ?? {
          ...metadata,
          StartingInstances: [
            {
              InstanceId: 'i-9',
              PreviousState: { Name: 'stopped' },
              CurrentState: { Name: 'pending' },
            },
          ],
        },
      )
    }
    if (command instanceof DescribeVolumesCommand) {
      const page = this.responses.volumes?.[this.volumeCalls] ?? { ...metadata }
      this.volumeCalls += 1
      return Promise.resolve(page)
    }
    if (command instanceof DescribeInstancesCommand) {
      const page = this.responses.describe?.[this.describeCalls] ?? { ...metadata }
      this.describeCalls += 1
      return Promise.resolve(page)
    }
    return Promise.resolve(metadata)
  }
}

/** Compile-time proof that the production client satisfies the seam it is handed to. */
export const sendIsAssignable = (client: EC2Client): Ec2CommandSender => client

const configuration: Ec2ComputeConfiguration = {
  amiId: 'ami-executor',
  instanceProfileArn: 'arn:aws:iam::1:instance-profile/executor',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupIds: ['sg-1'],
  stage: 'test',
}

const provisionerOver = (sender: StubEc2Sender) =>
  createEc2ComputeProvisioner({
    client: sender,
    configuration,
    selectSubnet: (subnetIds) => subnetIds[1] ?? '',
  })

describe('the EC2 compute provisioner', () => {
  it('launches one tagged instance with the envelope base64-encoded in user-data', async () => {
    const sender = new StubEc2Sender()

    const launched = await provisionerOver(sender).launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'on_demand',
      userData: '#!/bin/sh\necho envelope',
    })

    expect(launched).toEqual({
      instanceId: 'i-1',
      instanceType: 'c7g.large',
      purchaseMode: 'on_demand',
    })

    const [command] = sender.commands
    expect(command).toBeInstanceOf(RunInstancesCommand)
    expect((command as RunInstancesCommand).input).toMatchObject({
      ImageId: 'ami-executor',
      InstanceType: 'c7g.large',
      MinCount: 1,
      MaxCount: 1,
      SubnetId: 'subnet-b',
      SecurityGroupIds: ['sg-1'],
      InstanceInitiatedShutdownBehavior: 'terminate',
    })
    expect(
      Buffer.from((command as RunInstancesCommand).input.UserData ?? '', 'base64').toString('utf8'),
    ).toBe('#!/bin/sh\necho envelope')
    expect((command as RunInstancesCommand).input.TagSpecifications?.[0]?.Tags).toContainEqual({
      Key: WORKFLOW_ID_TAG,
      Value: 'workflow-1',
    })
  })

  it('asks for interruptible capacity only when the job spec says spot', async () => {
    const spotSender = new StubEc2Sender()
    await provisionerOver(spotSender).launch({
      workflowId: 'workflow-spot',
      instanceType: 'c7g.large',
      purchaseMode: 'spot',
      userData: 'x',
    })
    expect((spotSender.commands[0] as RunInstancesCommand).input.InstanceMarketOptions).toEqual({
      MarketType: 'spot',
    })

    const onDemandSender = new StubEc2Sender()
    await provisionerOver(onDemandSender).launch({
      workflowId: 'workflow-on-demand',
      instanceType: 'c7g.large',
      purchaseMode: 'on_demand',
      userData: 'x',
    })
    expect(
      (onDemandSender.commands[0] as RunInstancesCommand).input.InstanceMarketOptions,
    ).toBeUndefined()
  })

  it('fails loudly when EC2 accepts a launch but names no instance', async () => {
    const sender = new StubEc2Sender({ run: { ...metadata, Instances: [] } })

    await expect(
      provisionerOver(sender).launch({
        workflowId: 'workflow-1',
        instanceType: 'c7g.large',
        purchaseMode: 'spot',
        userData: 'x',
      }),
    ).rejects.toThrow(/returned no instance id/)
  })

  it('terminates by id', async () => {
    const sender = new StubEc2Sender()

    await provisionerOver(sender).terminate({ instanceId: 'i-9' })

    expect((sender.commands[0] as TerminateInstancesCommand).input).toEqual({
      InstanceIds: ['i-9'],
    })
  })

  it('follows pagination and reports the workflow tag the sweep matches on', async () => {
    const sender = new StubEc2Sender({
      describe: [
        {
          ...metadata,
          NextToken: 'page-2',
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-1',
                  State: { Name: 'running' },
                  Tags: [{ Key: WORKFLOW_ID_TAG, Value: 'workflow-1' }],
                },
              ],
            },
          ],
        },
        {
          ...metadata,
          Reservations: [
            { Instances: [{ InstanceId: 'i-2', State: { Name: 'stopping' }, Tags: [] }] },
          ],
        },
      ],
    })

    const instances = await provisionerOver(sender).listWorkflowInstances()

    expect(instances).toEqual([
      { instanceId: 'i-1', workflowId: 'workflow-1', state: 'running' },
      { instanceId: 'i-2', workflowId: undefined, state: 'stopping' },
    ])
    expect(sender.commands).toHaveLength(2)
    expect((sender.commands[1] as DescribeInstancesCommand).input.NextToken).toBe('page-2')
  })
})

/**
 * Stop, start and the disk in between (T092, 003/FR-039, FR-041).
 *
 * The assertion that carries the requirement is the last one: the launch still asks for
 * `InstanceInitiatedShutdownBehavior: 'terminate'` **while** the stop path exists. Those two look
 * contradictory at a glance, and the contradiction is the point — an instance may never stop
 * itself, because a crashed executor doing so would leave a billable stopped instance nothing is
 * watching; the platform stops it from outside instead. Asserting them together is what stops the
 * next reader "fixing" the launch to make pause work, which would make every pause a data-loss
 * risk and every crash a leak.
 */
describe('stopping and starting a workflow instance (003/FR-039, FR-041)', () => {
  it('stops by id and reports both sides of the transition', async () => {
    const sender = new StubEc2Sender()

    const transition = await provisionerOver(sender).stop({ instanceId: 'i-9' })

    expect((sender.commands[0] as StopInstancesCommand).input).toEqual({ InstanceIds: ['i-9'] })
    // `stopping`, not `stopped`: EC2 answers with the state it moved the instance to, and the
    // settled state arrives seconds later. A caller that waited for `stopped` inline would hold a
    // job open for the length of an instance shutdown.
    expect(transition).toEqual({
      instanceId: 'i-9',
      previousState: 'running',
      currentState: 'stopping',
    })
  })

  it('starts the same instance by id, which is the whole of a resume (FR-041)', async () => {
    const sender = new StubEc2Sender()

    const transition = await provisionerOver(sender).start({ instanceId: 'i-9' })

    const [command] = sender.commands
    expect(command).toBeInstanceOf(StartInstancesCommand)
    expect((command as StartInstancesCommand).input).toEqual({ InstanceIds: ['i-9'] })
    // No user data, no tags, no image: nothing here re-provisions anything. That absence is
    // FR-041 — the same instance, the same disk, the same working tree.
    expect(sender.commands).toHaveLength(1)
    expect(transition.previousState).toBe('stopped')
  })

  it('fails loudly when EC2 accepts a stop and reports no state change for it', async () => {
    const sender = new StubEc2Sender({ stop: { ...metadata, StoppingInstances: [] } })

    // Reported as a completed stop, this would leave the platform believing an instance was no
    // longer billing while it was.
    await expect(provisionerOver(sender).stop({ instanceId: 'i-9' })).rejects.toThrow(
      /reported no state change/,
    )
  })

  it('fails loudly when EC2 accepts a start and reports no state change for it', async () => {
    const sender = new StubEc2Sender({ start: { ...metadata, StartingInstances: [] } })

    await expect(provisionerOver(sender).start({ instanceId: 'i-9' })).rejects.toThrow(
      /reported no state change/,
    )
  })

  it('reads the attached volumes back by attachment, following pagination', async () => {
    const sender = new StubEc2Sender({
      volumes: [
        {
          ...metadata,
          NextToken: 'page-2',
          Volumes: [
            {
              VolumeId: 'vol-root',
              Size: 100,
              State: 'in-use',
              Attachments: [
                { InstanceId: 'i-9', Device: '/dev/xvda', DeleteOnTermination: true },
                // Another instance's attachment on the same answer: the adapter must read the one
                // it asked about, not the first one it is handed.
                { InstanceId: 'i-other', Device: '/dev/sdf', DeleteOnTermination: false },
              ],
            },
          ],
        },
        {
          ...metadata,
          Volumes: [
            {
              VolumeId: 'vol-data',
              Size: 500,
              State: 'in-use',
              Attachments: [{ InstanceId: 'i-9', DeleteOnTermination: false }],
            },
          ],
        },
      ],
    })

    const volumes = await provisionerOver(sender).describeVolumes({ instanceId: 'i-9' })

    expect(volumes).toEqual([
      {
        volumeId: 'vol-root',
        instanceId: 'i-9',
        deviceName: '/dev/xvda',
        sizeGib: 100,
        state: 'in-use',
        deleteOnTermination: true,
      },
      {
        volumeId: 'vol-data',
        instanceId: 'i-9',
        deviceName: undefined,
        sizeGib: 500,
        state: 'in-use',
        deleteOnTermination: false,
      },
    ])
    expect((sender.commands[0] as DescribeVolumesCommand).input.Filters?.[0]).toEqual({
      Name: 'attachment.instance-id',
      Values: ['i-9'],
    })
    expect((sender.commands[1] as DescribeVolumesCommand).input.NextToken).toBe('page-2')
  })

  it('answers empty for an instance with nothing attached rather than raising', async () => {
    const sender = new StubEc2Sender()

    await expect(
      provisionerOver(sender).describeVolumes({ instanceId: 'i-gone' }),
    ).resolves.toEqual([])
  })

  /**
   * **Do not "fix" this.** The launch and the stop disagree on purpose, and the disagreement is the
   * design: the instance may never stop itself, and the platform may.
   */
  it('still launches with instance-initiated shutdown set to terminate, beside the stop path', async () => {
    const sender = new StubEc2Sender()
    const provisioner = provisionerOver(sender)

    await provisioner.launch({
      workflowId: 'workflow-1',
      instanceType: 'c7g.large',
      purchaseMode: 'on_demand',
      userData: 'x',
    })
    await provisioner.stop({ instanceId: 'i-1' })

    expect((sender.commands[0] as RunInstancesCommand).input).toMatchObject({
      InstanceInitiatedShutdownBehavior: 'terminate',
    })
    expect(sender.commands[1]).toBeInstanceOf(StopInstancesCommand)
  })
})

/**
 * The login environment (T072, 003/FR-069, 003/FR-071).
 *
 * Every assertion below is about something the launch **does not** carry. That is the shape of the
 * requirement: a login instance is isolated from workflow execution not because anything guards it,
 * but because it is never put into the space workflows are drawn from. So the tests are written as
 * absences — no workflow tag, no envelope, no spot — and the last one in the section proves the
 * consequence those absences are for, against the sweep itself rather than against the request.
 */
describe('the EC2 login environment launch', () => {
  const expiresAt = new Date('2026-08-09T12:30:00.000Z')

  const launchLogin = async (sender: StubEc2Sender) =>
    provisionerOver(sender).launchLogin({
      agentCredentialId: 'credential-1',
      instanceType: 't4g.small',
      expiresAt,
      userData: '#!/bin/sh\nstart-agent-login',
    })

  it('tags the instance with the seat it is for and the deadline it dies on', async () => {
    const sender = new StubEc2Sender()

    const launched = await launchLogin(sender)

    expect(launched).toEqual({
      instanceId: 'i-1',
      agentCredentialId: 'credential-1',
      expiresAt,
    })

    const tags = (sender.commands[0] as RunInstancesCommand).input.TagSpecifications?.[0]?.Tags
    expect(tags).toContainEqual({ Key: CREDENTIAL_LOGIN_TAG, Value: 'credential-1' })
    // ISO-8601, so the reaper reads the same instant back whatever the sweep's own timezone is.
    expect(tags).toContainEqual({
      Key: LOGIN_EXPIRES_AT_TAG,
      Value: '2026-08-09T12:30:00.000Z',
    })
  })

  /**
   * **The isolation assertion, made where it would have to be broken.** A login instance carrying
   * `sisyphus:workflow-id` would land in the reconciler's population, be compared against the
   * leases, be attributed to a run or found unattributable — and in the second case terminated
   * mid-login as a leak.
   */
  it('carries no workflow tag at all, so nothing can attribute it to a run', async () => {
    const sender = new StubEc2Sender()

    await launchLogin(sender)

    const tags =
      (sender.commands[0] as RunInstancesCommand).input.TagSpecifications?.[0]?.Tags ?? []
    expect(tags.map((tag) => tag.Key)).not.toContain(WORKFLOW_ID_TAG)
  })

  it('never asks for interruptible capacity, because a person is waiting on it', async () => {
    const sender = new StubEc2Sender()

    await launchLogin(sender)

    expect((sender.commands[0] as RunInstancesCommand).input.InstanceMarketOptions).toBeUndefined()
  })

  it('passes the bundle-less boot script through verbatim and adds nothing to it', async () => {
    const sender = new StubEc2Sender()

    await launchLogin(sender)

    // The seam does not assemble user data and must not: what makes the environment
    // workspace-less is that the caller hands it a script with no envelope in it (003/FR-069).
    expect(
      Buffer.from(
        (sender.commands[0] as RunInstancesCommand).input.UserData ?? '',
        'base64',
      ).toString('utf8'),
    ).toBe('#!/bin/sh\nstart-agent-login')
  })

  it('fails loudly when EC2 accepts the launch but names no instance', async () => {
    const sender = new StubEc2Sender({ run: { ...metadata, Instances: [] } })

    // Worse than a failed workflow launch: there is no lease row to reconcile against, so an
    // instance nobody can name is an instance nobody will ever terminate.
    await expect(launchLogin(sender)).rejects.toThrow(/returned no instance id/)
  })

  it('lists login instances by their own tag, with the deadline parsed back', async () => {
    const sender = new StubEc2Sender({
      describe: [
        {
          ...metadata,
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-login-1',
                  State: { Name: 'running' },
                  Tags: [
                    { Key: CREDENTIAL_LOGIN_TAG, Value: 'credential-1' },
                    { Key: LOGIN_EXPIRES_AT_TAG, Value: '2026-08-09T12:30:00.000Z' },
                  ],
                },
                {
                  InstanceId: 'i-login-2',
                  State: { Name: 'pending' },
                  Tags: [{ Key: CREDENTIAL_LOGIN_TAG, Value: 'credential-2' }],
                },
              ],
            },
          ],
        },
      ],
    })

    const instances = await provisionerOver(sender).listLoginInstances()

    expect(instances).toEqual([
      { instanceId: 'i-login-1', agentCredentialId: 'credential-1', expiresAt, state: 'running' },
      // A missing deadline answers `undefined` rather than throwing: one malformed instance must
      // not take the sweep down and leave every other expired login running.
      {
        instanceId: 'i-login-2',
        agentCredentialId: 'credential-2',
        expiresAt: undefined,
        state: 'pending',
      },
    ])
    expect((sender.commands[0] as DescribeInstancesCommand).input.Filters?.[0]).toEqual({
      Name: 'tag-key',
      Values: [CREDENTIAL_LOGIN_TAG],
    })
  })

  it('treats a deadline it cannot read as no deadline rather than as a date in 1970', async () => {
    const sender = new StubEc2Sender({
      describe: [
        {
          ...metadata,
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: 'i-login-3',
                  State: { Name: 'running' },
                  Tags: [
                    { Key: CREDENTIAL_LOGIN_TAG, Value: 'credential-3' },
                    { Key: LOGIN_EXPIRES_AT_TAG, Value: 'yesterday' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    expect((await provisionerOver(sender).listLoginInstances())[0]?.expiresAt).toBeUndefined()
  })

  /**
   * **The property a workflow can never be scheduled onto a login instance reduces to.**
   *
   * There is no operation in this seam that attaches a run to an existing instance — a workflow
   * gets compute by `launch`, which creates one. So "unreachable by any workflow" is the claim that
   * a login instance is absent from every set the workflow machinery reads, and the only such set
   * is `listWorkflowInstances`. Asserted here against one account holding both kinds at once.
   */
  it('keeps the two populations disjoint: no login instance is ever a workflow instance', async () => {
    // An account holding one of each, behind a sender that honours the `tag-key` filter the way
    // EC2 does. Answering every query with everything would make this assertion vacuous — the
    // claim is about which set each sweep gets back, so the filter has to actually apply.
    const account = [
      {
        InstanceId: 'i-workflow',
        State: { Name: 'running' },
        Tags: [{ Key: WORKFLOW_ID_TAG, Value: 'workflow-1' }],
      },
      {
        InstanceId: 'i-login',
        State: { Name: 'running' },
        Tags: [
          { Key: CREDENTIAL_LOGIN_TAG, Value: 'credential-1' },
          { Key: LOGIN_EXPIRES_AT_TAG, Value: expiresAt.toISOString() },
        ],
      },
    ]

    class FilteringSender {
      public send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>
      public send(command: TerminateInstancesCommand): Promise<TerminateInstancesCommandOutput>
      public send(command: StopInstancesCommand): Promise<StopInstancesCommandOutput>
      public send(command: StartInstancesCommand): Promise<StartInstancesCommandOutput>
      public send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>
      public send(command: DescribeVolumesCommand): Promise<DescribeVolumesCommandOutput>
      public send(command: object): Promise<object> {
        if (!(command instanceof DescribeInstancesCommand)) {
          return Promise.resolve(metadata)
        }

        const key = command.input.Filters?.find((filter) => filter.Name === 'tag-key')?.Values?.[0]

        return Promise.resolve({
          ...metadata,
          Reservations: [
            {
              Instances: account.filter((instance) => instance.Tags.some((tag) => tag.Key === key)),
            },
          ],
        })
      }
    }

    const provisioner = createEc2ComputeProvisioner({
      client: new FilteringSender(),
      configuration,
      selectSubnet: (subnetIds) => subnetIds[0] ?? '',
    })

    const workflowInstances = await provisioner.listWorkflowInstances()
    const loginInstances = await provisioner.listLoginInstances()

    // The reconciler — the only thing that maps live instances onto runs — cannot see the login
    // box. That, plus the launch above writing no `sisyphus:workflow-id`, is the whole of
    // "unreachable by any workflow while it exists" (003/FR-071).
    expect(workflowInstances.map((instance) => instance.instanceId)).toStrictEqual(['i-workflow'])
    expect(loginInstances.map((instance) => instance.instanceId)).toStrictEqual(['i-login'])
  })
})
