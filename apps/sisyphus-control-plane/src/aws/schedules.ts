import type {
  CreateScheduleCommandOutput,
  DeleteScheduleCommandOutput,
  ListSchedulesCommandOutput,
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

/**
 * The schedule seam — what the control plane needs from EventBridge Scheduler (T054).
 *
 * The platform keeps one schedule per enabled integration, created, re-registered and removed as
 * schedule or enabled state changes (FR-100), and the same scheduler is what triggers admission,
 * the queue drain and the bootstrap reconcile — the control plane has no inbound network surface,
 * so a timer is how anything happens at all (FR-035, plan.md "How the panel reaches the control
 * plane").
 *
 * That makes the useful vocabulary **desired state**, not API calls: `upsert` one schedule,
 * `remove` one, and `list` what exists so a sweep can delete the schedules of integrations that
 * are gone. Create-versus-update is an implementation detail of `upsert` and deliberately not a
 * decision the caller has to get right — a caller that guesses wrong gets a `ConflictException`
 * for an integration whose cron simply changed.
 */

export interface ScheduleDefinition {
  /** Unique within the group; the platform derives it from the integration id. */
  readonly name: string
  /** A Scheduler expression, e.g. `cron(0/5 * * * ? *)` or `rate(5 minutes)`. */
  readonly expression: string
  /** IANA zone the expression is evaluated in, so a board's ticks land in its own working day. */
  readonly timezone: string
  /** JSON handed to the target invocation, identifying what this tick is for. */
  readonly payload: string
  /** A disabled schedule is kept rather than deleted, so its history and target survive. */
  readonly enabled?: boolean
}

export interface ScheduleRegistry {
  /** Create the schedule, or bring an existing one to this definition. */
  readonly upsert: (definition: ScheduleDefinition) => Promise<void>
  /** Delete a schedule. Idempotent: removing an absent schedule succeeds. */
  readonly remove: (input: { readonly name: string }) => Promise<void>
  /** Every schedule name in the group, so orphans can be swept. */
  readonly list: () => Promise<readonly string[]>
}

/** The subset of `SchedulerClient` this adapter uses. */
export interface SchedulerCommandSender {
  send(command: CreateScheduleCommand): Promise<CreateScheduleCommandOutput>
  send(command: UpdateScheduleCommand): Promise<UpdateScheduleCommandOutput>
  send(command: DeleteScheduleCommand): Promise<DeleteScheduleCommandOutput>
  send(command: ListSchedulesCommand): Promise<ListSchedulesCommandOutput>
}

export interface SchedulerConfiguration {
  /** The stage's schedule group, so one stage's schedules are listable without another's. */
  readonly groupName: string
  /** The control-plane function every tick invokes. */
  readonly targetArn: string
  /** Role Scheduler assumes to invoke the target. */
  readonly roleArn: string
}

export const createEventBridgeScheduleRegistry = (options: {
  readonly client: SchedulerCommandSender
  readonly configuration: SchedulerConfiguration
}): ScheduleRegistry => {
  const { client, configuration } = options

  const commandInput = (definition: ScheduleDefinition) => ({
    Name: definition.name,
    GroupName: configuration.groupName,
    ScheduleExpression: definition.expression,
    ScheduleExpressionTimezone: definition.timezone,
    State: definition.enabled === false ? ('DISABLED' as const) : ('ENABLED' as const),
    // A tick is due at its moment or not at all; a window would let two integrations' ticks drift
    // into each other and make per-tick ceilings (FR-107) harder to reason about than they are.
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    Target: {
      Arn: configuration.targetArn,
      RoleArn: configuration.roleArn,
      Input: definition.payload,
    },
  })

  return {
    upsert: async (definition) => {
      try {
        await client.send(new CreateScheduleCommand(commandInput(definition)))
      } catch (thrown) {
        if (!(thrown instanceof ConflictException)) {
          throw thrown
        }
        await client.send(new UpdateScheduleCommand(commandInput(definition)))
      }
    },

    remove: async (input) => {
      try {
        await client.send(
          new DeleteScheduleCommand({ Name: input.name, GroupName: configuration.groupName }),
        )
      } catch (thrown) {
        if (thrown instanceof ResourceNotFoundException) {
          return
        }
        throw thrown
      }
    },

    list: async () => {
      const names: string[] = []
      let nextToken: string | undefined

      do {
        const output: ListSchedulesCommandOutput = await client.send(
          new ListSchedulesCommand({ GroupName: configuration.groupName, NextToken: nextToken }),
        )

        for (const schedule of output.Schedules ?? []) {
          if (schedule.Name !== undefined) {
            names.push(schedule.Name)
          }
        }

        nextToken = output.NextToken
      } while (nextToken !== undefined)

      return names
    },
  }
}
