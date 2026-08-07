/**
 * Five-field cron, read and evaluated **in a named timezone** (T121, FR-154, FR-155).
 *
 * FR-154 will not let a schedule be saved without a plain-language readback and the next five fire
 * times, and FR-155 says those fire times are in the integration's **own** timezone with
 * daylight-saving transitions handled so a wall-clock schedule stays at its wall-clock time. The
 * two are one requirement in practice: a readback saying "every day at 09:00" beside a list of
 * times in the reader's browser timezone is worse than no readback, because it looks checked.
 *
 * ## Why the arithmetic is done on wall clocks rather than on instants
 *
 * A cron expression describes a **wall clock**, not an instant. `0 9 * * *` in `Europe/London`
 * means 09:00 in London — 08:00 UTC in winter and 09:00 UTC in summer. Anything that converts the
 * expression to UTC once and then adds fixed intervals drifts by an hour twice a year, in the
 * direction nobody notices until a board starts ticking at 08:00.
 *
 * So this generates *candidate wall clocks* in the zone and converts each one to an instant, rather
 * than generating instants and formatting them. {@link instantFromWallClock} does the conversion
 * with the two-pass offset solve that is the standard way to do it without a timezone library: take
 * the offset near the guessed instant, apply it, then take the offset again at the corrected
 * instant, because the first offset may have been the wrong side of a transition.
 *
 * ## The two transition cases, both handled rather than ignored
 *
 * - **Spring forward** deletes an hour of wall clock. A schedule at 01:30 in a zone that jumps
 *   01:00→02:00 has no instant that day. The candidate is dropped, verified by round-tripping the
 *   instant back to wall clock and checking it is the time that was asked for — a schedule that
 *   silently fired at 02:30 instead would be a schedule nobody wrote.
 * - **Autumn back** repeats an hour. The two-pass solve settles on the first occurrence, and the
 *   duplicate is removed, so an admin is shown one 01:30 rather than two.
 *
 * ## No dependency
 *
 * `Intl.DateTimeFormat` with a `timeZone` is in the platform and carries the IANA database with it.
 * A date library here would be a second source of zone data to keep current.
 */

/** What one cron field allows. `'any'` is `*` — kept distinct from "every value" for day fields. */
export type CronField = 'any' | ReadonlySet<number>

export interface CronFields {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: CronField
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: CronField
}

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const
/** Padded so the index is the cron month number: `MONTH_NAMES[1] === 'JAN'`. */
const MONTH_NAMES = [
  '',
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const

/**
 * The element at an index, honestly typed.
 *
 * `noUncheckedIndexedAccess` is off in this workspace, so `parts[1]` is typed as present even when
 * the split produced one element — and a `=== undefined` guard against it is narrowed away as
 * unreachable. A function whose declared return type admits `undefined` restores the check.
 */
const elementAt = (values: readonly string[], index: number): string | undefined => values[index]

const nameToNumber = (token: string, names: readonly string[]): number | undefined => {
  const index = names.indexOf(token.toUpperCase())
  return index === -1 ? undefined : index
}

/**
 * One field: a wildcard, a value, a range, a list, any of those with a `/step`, and the
 * three-letter day and month names.
 *
 * @returns The allowed values, or `undefined` when the field is not something this can read. An
 *   unreadable field is never treated as `*`: widening a schedule an admin wrote narrowly is how a
 *   board starts ticking every minute.
 */
export const parseCronField = (
  field: string,
  min: number,
  max: number,
  names: readonly string[] = [],
): ReadonlySet<number> | undefined => {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const segments = part.split('/')
    const range = elementAt(segments, 0) ?? ''
    const stepText = elementAt(segments, 1)
    const step = stepText === undefined ? 1 : Number(stepText)

    if (!Number.isInteger(step) || step < 1 || stepText?.length === 0) {
      return undefined
    }

    let from: number
    let to: number

    if (range === '*') {
      from = min
      to = max
    } else if (range.includes('-')) {
      const bounds = range.split('-')
      const low = elementAt(bounds, 0) ?? ''
      const high = elementAt(bounds, 1) ?? ''
      const start = nameToNumber(low, names) ?? Number(low)
      const end = nameToNumber(high, names) ?? Number(high)

      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return undefined
      }

      from = start
      to = end
    } else {
      const single = nameToNumber(range, names) ?? Number(range)

      if (!Number.isInteger(single)) {
        return undefined
      }

      from = single
      // `a/n` counts up from `a` to the end of the field, which is what crontab means by it.
      to = stepText === undefined ? single : max
    }

    if (from < min || to > max || from > to) {
      return undefined
    }

    for (let value = from; value <= to; value += step) {
      values.add(value)
    }
  }

  return values.size === 0 ? undefined : values
}

/**
 * Read a five-field expression.
 *
 * @returns The fields, or `undefined` when the expression cannot be read — which the panel renders
 *   as "this expression could not be read" rather than as an empty list of fire times.
 */
export const parseCron = (expression: string): CronFields | undefined => {
  const fields = expression.trim().split(/\s+/)

  if (fields.length !== 5) {
    return undefined
  }

  const minuteText = elementAt(fields, 0) ?? ''
  const hourText = elementAt(fields, 1) ?? ''
  const dayOfMonthText = elementAt(fields, 2) ?? ''
  const monthText = elementAt(fields, 3) ?? ''
  const dayOfWeekText = elementAt(fields, 4) ?? ''

  const minutes = parseCronField(minuteText, 0, 59)
  const hours = parseCronField(hourText, 0, 23)
  const months = parseCronField(monthText, 1, 12, MONTH_NAMES)

  if (minutes === undefined || hours === undefined || months === undefined) {
    return undefined
  }

  const daysOfMonth =
    dayOfMonthText === '*' || dayOfMonthText === '?' ? 'any' : parseCronField(dayOfMonthText, 1, 31)
  const daysOfWeek =
    dayOfWeekText === '*' || dayOfWeekText === '?'
      ? 'any'
      : parseCronField(dayOfWeekText, 0, 6, DAY_NAMES)

  if (daysOfMonth === undefined || daysOfWeek === undefined) {
    return undefined
  }

  return { minutes, hours, daysOfMonth, months, daysOfWeek }
}

/** A wall-clock moment in some zone. `month` is 1-based, as cron writes it. */
export interface WallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  /** 0 = Sunday, as cron numbers it. */
  readonly weekday: number
}

const partsFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })

/** What clock a zone reads at an instant. */
export const wallClockIn = (instant: Date, timeZone: string): WallClock => {
  const parts = new Map(
    partsFormatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  )

  // `en-GB` renders midnight as `24` rather than `00` for the `hour` part; normalise it.
  const hour = Number(parts.get('hour') ?? '0') % 24

  return {
    year: Number(parts.get('year') ?? '1970'),
    month: Number(parts.get('month') ?? '1'),
    day: Number(parts.get('day') ?? '1'),
    hour,
    minute: Number(parts.get('minute') ?? '0'),
    weekday: DAY_NAMES.indexOf(
      (parts.get('weekday') ?? 'Sun').slice(0, 3).toUpperCase() as (typeof DAY_NAMES)[number],
    ),
  }
}

/** The zone's offset from UTC at an instant, in milliseconds. */
const offsetAt = (instant: Date, timeZone: string): number => {
  const clock = wallClockIn(instant, timeZone)
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute)

  // Seconds and milliseconds are not in the formatted parts, so compare on whole minutes.
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000
}

/**
 * The instant at which a zone reads a given wall clock.
 *
 * @returns The instant, or `undefined` for a wall clock the zone skipped over at a daylight-saving
 *   transition. `undefined` rather than the nearest instant, because a schedule shifted to a time
 *   nobody chose is worse than one that visibly did not fire.
 */
export const instantFromWallClock = (
  wanted: Omit<WallClock, 'weekday'>,
  timeZone: string,
): Date | undefined => {
  const asUtc = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute)
  const firstPass = new Date(asUtc - offsetAt(new Date(asUtc), timeZone))
  const instant = new Date(asUtc - offsetAt(firstPass, timeZone))
  const round = wallClockIn(instant, timeZone)

  if (
    round.year !== wanted.year ||
    round.month !== wanted.month ||
    round.day !== wanted.day ||
    round.hour !== wanted.hour ||
    round.minute !== wanted.minute
  ) {
    return undefined
  }

  return instant
}

const matchesDay = (fields: CronFields, clock: WallClock): boolean => {
  if (!fields.months.has(clock.month)) {
    return false
  }

  const dayOfMonthMatches =
    fields.daysOfMonth === 'any' ? undefined : fields.daysOfMonth.has(clock.day)
  const dayOfWeekMatches =
    fields.daysOfWeek === 'any' ? undefined : fields.daysOfWeek.has(clock.weekday)

  if (dayOfMonthMatches === undefined && dayOfWeekMatches === undefined) {
    return true
  }

  // Standard cron takes the union when both are constrained. `sync-schedules.ts` refuses to
  // register such an expression at all, so the readback and the registration cannot disagree — but
  // reading it the standard way here is what lets the panel show *why* it is being refused.
  return (dayOfMonthMatches ?? false) || (dayOfWeekMatches ?? false)
}

/** How far ahead a search will look before giving up on a schedule that never fires. */
const MAX_DAYS_AHEAD = 400

/**
 * The next fire times of an expression, in the integration's own timezone (FR-154, FR-155).
 *
 * @param expression - Five-field cron.
 * @param timeZone - IANA zone the expression is evaluated in.
 * @param count - How many to produce. FR-154 asks for five.
 * @param from - The moment to search after. Injectable so a test states the clock.
 * @returns The instants, ascending. Empty when the expression is unreadable or never fires.
 */
export const nextFireTimes = (
  expression: string,
  timeZone: string,
  count = 5,
  from: Date = new Date(),
): readonly Date[] => {
  const fields = parseCron(expression)

  if (fields === undefined || count < 1) {
    return []
  }

  const hours = [...fields.hours].sort((left, right) => left - right)
  const minutes = [...fields.minutes].sort((left, right) => left - right)
  const found: Date[] = []
  // A whole day back, so the first day examined is the one `from` is in whatever the offset.
  const cursor = new Date(from.getTime())

  for (let day = 0; day < MAX_DAYS_AHEAD && found.length < count; day += 1) {
    const clock = wallClockIn(new Date(cursor.getTime() + day * 86_400_000), timeZone)

    if (!matchesDay(fields, clock)) {
      continue
    }

    for (const hour of hours) {
      for (const minute of minutes) {
        if (found.length >= count) {
          break
        }

        const instant = instantFromWallClock(
          { year: clock.year, month: clock.month, day: clock.day, hour, minute },
          timeZone,
        )

        if (
          instant !== undefined &&
          instant.getTime() > from.getTime() &&
          !found.some((existing) => existing.getTime() === instant.getTime())
        ) {
          found.push(instant)
        }
      }
    }
  }

  return found.sort((left, right) => left.getTime() - right.getTime())
}

/** A fire time as the board's own clock reads it — never the reader's browser (FR-155). */
export const formatInZone = (instant: Date, timeZone: string): string => {
  const clock = wallClockIn(instant, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')

  return `${String(clock.year)}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`
}

const listOf = (values: ReadonlySet<number>, render: (value: number) => string): string => {
  const sorted = [...values].sort((left, right) => left - right).map(render)

  if (sorted.length <= 2) {
    return sorted.join(' and ')
  }

  return `${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`
}

const isEveryValue = (values: ReadonlySet<number>, min: number, max: number): boolean =>
  values.size === max - min + 1

/**
 * The plain-language readback FR-154 requires before a schedule may be saved.
 *
 * Deliberately describes the expression rather than the preset that produced it: an admin who typed
 * a raw expression gets a sentence derived from what they typed, which is the only version of this
 * that can catch a typo.
 */
export const describeCron = (expression: string): string => {
  const fields = parseCron(expression)

  if (fields === undefined) {
    return 'this expression could not be read, so its fire times cannot be shown'
  }

  const everyMinute = isEveryValue(fields.minutes, 0, 59)
  const everyHour = isEveryValue(fields.hours, 0, 23)
  const pad = (value: number): string => String(value).padStart(2, '0')

  const time = ((): string => {
    if (everyMinute && everyHour) {
      return 'every minute'
    }

    if (everyHour) {
      return `at ${listOf(fields.minutes, (minute) => `minute ${String(minute)}`)} of every hour`
    }

    if (everyMinute) {
      return `every minute during ${listOf(fields.hours, (hour) => `${pad(hour)}:00`)}`
    }

    const times: string[] = []
    for (const hour of [...fields.hours].sort((left, right) => left - right)) {
      for (const minute of [...fields.minutes].sort((left, right) => left - right)) {
        times.push(`${pad(hour)}:${pad(minute)}`)
      }
    }

    return `at ${times.length > 4 ? `${times.slice(0, 4).join(', ')} and ${String(times.length - 4)} more` : times.join(', ')}`
  })()

  const days = ((): string => {
    if (fields.daysOfWeek !== 'any') {
      return ` on ${listOf(fields.daysOfWeek, (day) => DAY_NAMES[day] ?? String(day))}`
    }

    if (fields.daysOfMonth !== 'any') {
      return ` on day ${listOf(fields.daysOfMonth, (day) => String(day))} of the month`
    }

    return ' every day'
  })()

  const months = isEveryValue(fields.months, 1, 12)
    ? ''
    : ` in ${listOf(fields.months, (month) => MONTH_NAMES[month] ?? String(month))}`

  return `${time}${days}${months}`
}
