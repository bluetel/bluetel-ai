import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ValidationResult } from './validation-result'

const STARTED = new Date('2026-08-05T09:00:00.000Z')
const ENDED = new Date('2026-08-05T09:04:00.000Z')

describe('ValidationResult', () => {
  it('says "never validated" when there is no run, rather than showing a hopeful default', () => {
    const markup = renderToStaticMarkup(<ValidationResult />)

    expect(markup).toContain('never validated')
    // The idle chip. Graphite is the one colour not locked to a machine state, which is exactly
    // what "no result" is (FR-025).
    expect(markup).toContain('data-state="idle"')
    expect(markup).toContain('text-graphite')
  })

  it('never renders a pass or a failure when there is no run', () => {
    const markup = renderToStaticMarkup(<ValidationResult />)

    expect(markup).not.toContain('passed')
    expect(markup).not.toContain('failed')
  })

  it('shows a pass in verdigris, against the version it exercised (FR-148)', () => {
    const markup = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 3, outcome: 'passed', startedAt: STARTED, endedAt: ENDED }}
      />,
    )

    expect(markup).toContain('passed v3')
    expect(markup).toContain('data-state="succeeded"')
    expect(markup).toContain('text-verdigris')
  })

  it('shows a failure in rust', () => {
    const markup = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 2, outcome: 'failed', startedAt: STARTED, endedAt: ENDED }}
      />,
    )

    expect(markup).toContain('failed v2')
    expect(markup).toContain('data-state="failed"')
    expect(markup).toContain('text-rust')
  })

  it('names the version, so a stale pass cannot read as a guarantee about the current archive', () => {
    const markup = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 1, outcome: 'passed', startedAt: STARTED, endedAt: ENDED }}
      />,
    )

    expect(markup).toContain('v1')
  })

  it('reports a run with no verdict as in flight, with the pulsing lamp', () => {
    const markup = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 1, outcome: null, startedAt: STARTED, endedAt: null }}
      />,
    )

    expect(markup).toContain('validating v1')
    expect(markup).toContain('data-state="running"')
    // The LED pulse is the system's one looping animation and it means "working".
    expect(markup).toContain('animate-')
  })

  it('timestamps a finished run at its end and an unfinished one at its start', () => {
    const finished = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 1, outcome: 'passed', startedAt: STARTED, endedAt: ENDED }}
      />,
    )
    const running = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 1, outcome: null, startedAt: STARTED, endedAt: null }}
      />,
    )

    expect(finished).toContain('2026-08-05 09:04 UTC')
    expect(running).toContain('2026-08-05 09:00 UTC')
  })

  it('writes no literal colour or size — every value is a token (SC-015)', () => {
    const markup = renderToStaticMarkup(
      <ValidationResult
        validation={{ version: 1, outcome: 'passed', startedAt: STARTED, endedAt: ENDED }}
      />,
    )

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/\d+(px|rem)/)
  })
})
