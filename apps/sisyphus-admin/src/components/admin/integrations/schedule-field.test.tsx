import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ScheduleField } from './schedule-field'

const noop = () => undefined
const NOW = new Date('2026-08-05T10:00:00Z')

const render = (props: Partial<Parameters<typeof ScheduleField>[0]> = {}) =>
  renderToStaticMarkup(
    <ScheduleField
      expression="0/15 * * * *"
      timezone="Europe/London"
      onExpressionChange={noop}
      onTimezoneChange={noop}
      now={NOW}
      {...props}
    />,
  )

describe('ScheduleField (T121, FR-154, FR-155)', () => {
  it('offers named presets', () => {
    const markup = render()

    expect(markup).toContain('Every 15 minutes')
    expect(markup).toContain('Weekday mornings at 09:00')
  })

  it('offers a raw cron expression as the escape hatch', () => {
    expect(render()).toContain('Custom — write a cron expression')
  })

  it('hides the raw control while a preset is chosen, so cron is a deliberate choice', () => {
    expect(render()).not.toContain('Cron expression')
  })

  it('reveals the raw control for an expression that is not a preset', () => {
    expect(render({ expression: '7 3 * * 2' })).toContain('Cron expression')
  })

  it('shows the plain-language readback (FR-154)', () => {
    expect(render({ expression: '0 9 * * *' })).toContain('at 09:00 every day')
  })

  it('shows the next five fire times (FR-154)', () => {
    const markup = render({ expression: '0 9 * * *' })

    for (const day of ['2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10']) {
      expect(markup).toContain(`${day} 09:00`)
    }
  })

  it('labels the fire times with the timezone they are in (FR-155)', () => {
    expect(render({ timezone: 'Australia/Sydney' })).toContain('next 5 runs — Australia/Sydney')
  })

  it('renders the fire times in the integration timezone, not the reader timezone', () => {
    expect(render({ expression: '0 9 * * *', timezone: 'Australia/Sydney' })).toContain(
      '2026-08-06 09:00',
    )
  })

  it('always offers the integration current timezone, so editing cannot move it', () => {
    expect(render({ timezone: 'Pacific/Auckland' })).toContain('Pacific/Auckland')
  })

  it('says a schedule it cannot read cannot be saved', () => {
    const markup = render({ expression: 'every fifteen minutes' })

    expect(markup).toContain('cannot be shown, so it cannot be saved')
    expect(markup).not.toContain('next 5 runs')
  })

  it('explains that the schedule is read in the timezone, and why that matters', () => {
    expect(render()).toContain('daylight-saving change')
  })

  it('renders a refusal on the expression', () => {
    expect(
      render({ expressionError: { code: 'unreadable_schedule', action: 'Pick a preset.' } }),
    ).toContain('Pick a preset.')
  })

  it('renders a refusal on the timezone', () => {
    expect(
      render({ timezoneError: { code: 'unknown_timezone', action: 'Choose a known zone.' } }),
    ).toContain('Choose a known zone.')
  })
})
