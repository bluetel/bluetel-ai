import type {
  CreateScheduleCommandOutput,
  DeleteScheduleCommandOutput,
  ListSchedulesCommandOutput,
  SchedulerClient,
  UpdateScheduleCommandOutput,
} from '@aws-sdk/client-scheduler'
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler'
import { describe, expect, it } from 'vitest'

import type { ScheduleDefinition, SchedulerCommandSender } from './schedules'
import { createEventBridgeScheduleRegistry } from './schedules'

const metadata = { $metadata: {} }

/** See `compute.test.ts` for why the stub is a class. */
class StubSchedulerSender {
  public readonly commands: object[] = []
  private listCalls = 0

  public constructor(
    private readonly responses: {
      readonly create?: Error
      readonly remove?: Error
      readonly list?: readonly ListSchedulesCommandOutput[]
    } = {},
  ) {}

  public send(command: CreateScheduleCommand): Promise<CreateScheduleCommandOutput>
  public send(command: UpdateScheduleCommand): Promise<UpdateScheduleCommandOutput>
  public send(command: DeleteScheduleCommand): Promise<DeleteScheduleCommandOutput>
  public send(command: ListSchedulesCommand): Promise<ListSchedulesCommandOutput>
  public send(command: object): Promise<object> {
    this.commands.push(command)

    if (command instanceof CreateScheduleCommand && this.responses.create !== undefined) {
      return Promise.reject(this.responses.create)
    }
    if (command instanceof DeleteScheduleCommand && this.responses.remove !== undefined) {
      return Promise.reject(this.responses.remove)
    }
    if (command instanceof ListSchedulesCommand) {
      const page = this.responses.list?.[this.listCalls] ?? metadata
      this.listCalls += 1
      return Promise.resolve(page)
    }
    return Promise.resolve(metadata)
  }
}

const configuration = {
  groupName: 'sisyphus-test',
  targetArn: 'arn:aws:lambda:eu-west-2:1:function:control-plane',
  roleArn: 'arn:aws:iam::1:role/scheduler',
}

const registryOver = (sender: StubSchedulerSender) =>
  createEventBridgeScheduleRegistry({ client: sender, configuration })

const definition: ScheduleDefinition = {
  name: 'integration-1',
  expression: 'cron(0/5 * * * ? *)',
  timezone: 'Europe/London',
  payload: '{"integrationId":"integration-1"}',
}

describe('the EventBridge schedule registry', () => {
  it('creates a schedule in the stage group with a fixed firing time', async () => {
    const sender = new StubSchedulerSender()

    await registryOver(sender).upsert(definition)

    expect(sender.commands).toHaveLength(1)
    expect((sender.commands[0] as CreateScheduleCommand).input).toMatchObject({
      Name: 'integration-1',
      GroupName: 'sisyphus-test',
      ScheduleExpression: 'cron(0/5 * * * ? *)',
      ScheduleExpressionTimezone: 'Europe/London',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: configuration.targetArn,
        RoleArn: configuration.roleArn,
        Input: '{"integrationId":"integration-1"}',
      },
    })
  })

  it('updates instead when the schedule already exists — a changed cron, not a failure', async () => {
    const sender = new StubSchedulerSender({
      create: new ConflictException({ message: 'exists', Message: 'exists', $metadata: {} }),
    })

    await registryOver(sender).upsert(definition)

    expect(sender.commands[0]).toBeInstanceOf(CreateScheduleCommand)
    expect(sender.commands[1]).toBeInstanceOf(UpdateScheduleCommand)
    expect((sender.commands[1] as UpdateScheduleCommand).input).toMatchObject({
      Name: 'integration-1',
      ScheduleExpression: 'cron(0/5 * * * ? *)',
    })
  })

  it('rethrows a create failure that is not a conflict', async () => {
    const sender = new StubSchedulerSender({ create: new Error('ValidationException') })

    await expect(registryOver(sender).upsert(definition)).rejects.toThrow('ValidationException')
  })

  it('keeps a disabled integration as a disabled schedule rather than deleting it', async () => {
    const sender = new StubSchedulerSender()

    await registryOver(sender).upsert({ ...definition, enabled: false })

    expect((sender.commands[0] as CreateScheduleCommand).input.State).toBe('DISABLED')
  })

  it('treats removing an absent schedule as done', async () => {
    const sender = new StubSchedulerSender({
      remove: new ResourceNotFoundException({ message: 'gone', Message: 'gone', $metadata: {} }),
    })

    await expect(registryOver(sender).remove({ name: 'integration-1' })).resolves.toBeUndefined()
    expect((sender.commands[0] as DeleteScheduleCommand).input).toEqual({
      Name: 'integration-1',
      GroupName: 'sisyphus-test',
    })
  })

  it('rethrows a delete failure that leaves the schedule ticking', async () => {
    const sender = new StubSchedulerSender({ remove: new Error('ThrottlingException') })

    await expect(registryOver(sender).remove({ name: 'integration-1' })).rejects.toThrow(
      'ThrottlingException',
    )
  })

  it('lists every schedule in the group across pages', async () => {
    const sender = new StubSchedulerSender({
      list: [
        { ...metadata, NextToken: 'page-2', Schedules: [{ Name: 'integration-1' }] },
        { ...metadata, Schedules: [{ Name: 'integration-2' }, {}] },
      ],
    })

    await expect(registryOver(sender).list()).resolves.toEqual(['integration-1', 'integration-2'])
    expect((sender.commands[1] as ListSchedulesCommand).input.NextToken).toBe('page-2')
  })
})

/** Compile-time proof that the production client satisfies the seam. */
export const senderIsAssignable = (client: SchedulerClient): SchedulerCommandSender => client
