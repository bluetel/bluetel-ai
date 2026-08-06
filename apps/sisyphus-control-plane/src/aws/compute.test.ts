import type {
  DescribeInstancesCommandOutput,
  EC2Client,
  RunInstancesCommandOutput,
  TerminateInstancesCommandOutput,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2'
import { DescribeInstancesCommand, RunInstancesCommand } from '@aws-sdk/client-ec2'
import { describe, expect, it } from 'vitest'

import type { Ec2CommandSender, Ec2ComputeConfiguration } from './compute'
import { createEc2ComputeProvisioner, WORKFLOW_ID_TAG } from './compute'

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
    } = {},
  ) {}

  private describeCalls = 0

  public send(command: RunInstancesCommand): Promise<RunInstancesCommandOutput>
  public send(command: TerminateInstancesCommand): Promise<TerminateInstancesCommandOutput>
  public send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>
  public send(command: object): Promise<object> {
    this.commands.push(command)

    if (command instanceof RunInstancesCommand) {
      return Promise.resolve(
        this.responses.run ?? { ...metadata, Instances: [{ InstanceId: 'i-1' }] },
      )
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
