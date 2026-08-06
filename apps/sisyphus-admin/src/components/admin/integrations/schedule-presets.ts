import { describeCron, formatInZone, nextFireTimes, parseCron } from './cron-schedule'

/**
 * Named schedule presets, with the raw expression as the escape hatch (T121, FR-154).
 *
 * FR-154 asks for named presets *and* a raw cron expression, and for a readback plus the next five
 * fire times before a schedule can be saved. The presets are not a convenience layer over the raw
 * field — they are the primary control, because "every 15 minutes" is what an admin means and
 * `0/15 * * * *` is a thing they have to be right about. The raw field exists for the schedule
 * nobody anticipated, and choosing it is a deliberate act rather than the default.
 *
 * **Every preset is stored as the cron expression it stands for.** There is no `preset` column and
 * there should not be one: the schedule that runs is the expression, so a stored preset name would
 * be a second description of the same thing, free to disagree with it after an edit.
 */

/** One named schedule an admin can pick without writing cron. */
export interface SchedulePreset {
  /** Stable key, for the control's value. */
  readonly id: string
  /** What an admin would call it. */
  readonly label: string
  readonly expression: string
}

/**
 * `hourly` fires at minute 0, not at "now plus an hour": a schedule whose phase depends on when it
 * was saved is one nobody can reason about across a redeploy.
 */
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { id: 'every-5-minutes', label: 'Every 5 minutes', expression: '0/5 * * * *' },
  { id: 'every-15-minutes', label: 'Every 15 minutes', expression: '0/15 * * * *' },
  { id: 'every-30-minutes', label: 'Every 30 minutes', expression: '0/30 * * * *' },
  { id: 'hourly', label: 'Hourly, on the hour', expression: '0 * * * *' },
  { id: 'weekday-mornings', label: 'Weekday mornings at 09:00', expression: '0 9 * * MON-FRI' },
  { id: 'daily-morning', label: 'Every day at 09:00', expression: '0 9 * * *' },
  { id: 'daily-overnight', label: 'Every day at 02:00', expression: '0 2 * * *' },
]

/** The value the control uses when an admin is writing their own expression. */
export const CUSTOM_SCHEDULE_ID = 'custom'

/** Which preset an expression is, or {@link CUSTOM_SCHEDULE_ID} when it is not one of them. */
export const presetForExpression = (expression: string): string =>
  SCHEDULE_PRESETS.find((preset) => preset.expression === expression.trim())?.id ??
  CUSTOM_SCHEDULE_ID

export const expressionForPreset = (presetId: string): string | undefined =>
  SCHEDULE_PRESETS.find((preset) => preset.id === presetId)?.expression

/** Everything FR-154 requires shown before a schedule may be saved. */
export interface ScheduleReadback {
  /** Plain language, derived from the expression rather than from the preset that produced it. */
  readonly description: string
  /** The next five, rendered in the integration's own timezone (FR-155). */
  readonly nextRuns: readonly string[]
  /** False when the expression could not be read — which is what blocks the save. */
  readonly readable: boolean
  /** The zone the times above are in, stated so a reader never has to assume. */
  readonly timezone: string
}

/** How many fire times FR-154 asks for. */
export const NEXT_RUN_COUNT = 5

/**
 * The readback for one expression in one zone.
 *
 * @param expression - Five-field cron, from a preset or typed by hand.
 * @param timezone - The integration's IANA zone (FR-155).
 * @param from - Injectable so a test states the clock rather than racing it.
 */
export const scheduleReadback = (
  expression: string,
  timezone: string,
  from: Date = new Date(),
): ScheduleReadback => {
  const readable = parseCron(expression) !== undefined && isKnownTimezone(timezone)

  return {
    description: describeCron(expression),
    nextRuns: readable
      ? nextFireTimes(expression, timezone, NEXT_RUN_COUNT, from).map((instant) =>
          formatInZone(instant, timezone),
        )
      : [],
    readable,
    timezone,
  }
}

/**
 * Whether the platform can evaluate this zone at all.
 *
 * A zone `Intl` does not recognise throws rather than defaulting, and a schedule saved against one
 * would be a schedule whose fire times nobody could compute — so it is caught here, where an admin
 * can still fix it, rather than at the next tick.
 */
export const isKnownTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

/**
 * A short list of zones to offer, with the reader's own first.
 *
 * Not the full IANA list: a five-hundred-entry picker is not a choice, it is a search box. The
 * integration's current zone is always included, so editing an integration configured with a zone
 * outside this list cannot silently move it.
 */
export const timezoneOptions = (
  current: string,
  detected: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): readonly string[] => {
  const common = [
    'Europe/London',
    'Europe/Dublin',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Singapore',
    'Australia/Sydney',
    'UTC',
  ]

  return [...new Set([current, detected, ...common].filter((zone) => zone.length > 0))]
}
