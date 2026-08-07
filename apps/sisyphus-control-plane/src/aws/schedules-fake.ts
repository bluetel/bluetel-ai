import type { ScheduleDefinition, ScheduleRegistry } from './schedules'

/**
 * Recording fake for {@link ScheduleRegistry}.
 *
 * It keeps the *current* definition per name as well as the sequence of upserts, because the two
 * answer different questions: "does the board now tick every five minutes" is about the current
 * state, and "was the schedule re-registered when the cron changed" (FR-100) is about the sequence.
 * A fake that only kept one of them would make one of those tests impossible to write honestly.
 */

export interface FakeScheduleRegistry extends ScheduleRegistry {
  /** Every upsert, in order, including repeats of an unchanged definition. */
  readonly upserts: readonly ScheduleDefinition[]
  /** Names passed to `remove`, in order. */
  readonly removals: readonly string[]
  /** The definition currently in force for a name. */
  readonly current: (name: string) => ScheduleDefinition | undefined
}

export const createFakeScheduleRegistry = (): FakeScheduleRegistry => {
  const schedules = new Map<string, ScheduleDefinition>()
  const upserts: ScheduleDefinition[] = []
  const removals: string[] = []

  return {
    upserts,
    removals,

    current: (name) => schedules.get(name),

    upsert: (definition) => {
      upserts.push(definition)
      schedules.set(definition.name, definition)
      return Promise.resolve()
    },

    remove: (input) => {
      removals.push(input.name)
      schedules.delete(input.name)
      return Promise.resolve()
    },

    list: () => Promise.resolve([...schedules.keys()].sort()),
  }
}
