import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Meter, meterFillPercent } from './meter'

describe('meterFillPercent', () => {
  it('reads a value as its share of the ceiling', () => {
    expect(meterFillPercent(25, 100)).toBe(25)
    expect(meterFillPercent(4.1, 10)).toBeCloseTo(41)
  })

  it('clamps an over-cap reading rather than overshooting the track', () => {
    expect(meterFillPercent(150, 100)).toBe(100)
  })

  it('reads a zero or negative value as empty', () => {
    expect(meterFillPercent(0, 100)).toBe(0)
    expect(meterFillPercent(-5, 100)).toBe(0)
  })

  it('reads any spend against a zero or absent ceiling as full', () => {
    expect(meterFillPercent(5, 0)).toBe(100)
    expect(meterFillPercent(5, -1)).toBe(100)
  })

  it('never produces NaN from a non-finite reading', () => {
    expect(meterFillPercent(Number.NaN, 100)).toBe(0)
    expect(meterFillPercent(5, Number.NaN)).toBe(100)
    expect(meterFillPercent(Number.POSITIVE_INFINITY, 100)).toBe(0)
  })
})

describe('Meter', () => {
  it('is a hairline track with a signal fill', () => {
    const markup = renderToStaticMarkup(<Meter value={40} max={100} label="Spend" />)
    expect(markup).toContain('bg-hairline')
    expect(markup).toContain('bg-signal')
    expect(markup).toContain('h-meter')
  })

  it('never uses a state colour, because a quantity is not a machine state', () => {
    const markup = renderToStaticMarkup(<Meter value={99} max={100} label="Spend" />)
    expect(markup).not.toMatch(/amber|verdigris|rust/)
  })

  it('reports its reading to assistive technology', () => {
    const markup = renderToStaticMarkup(
      <Meter value={4.1} max={10} label="Spend" valueText="$4.10 of $10.00" />,
    )
    expect(markup).toContain('role="meter"')
    expect(markup).toContain('aria-label="Spend"')
    expect(markup).toContain('aria-valuenow="4.1"')
    expect(markup).toContain('aria-valuemax="10"')
    expect(markup).toContain('aria-valuetext="$4.10 of $10.00"')
  })

  it('sizes the fill from the reading', () => {
    expect(renderToStaticMarkup(<Meter value={25} max={100} label="Spend" />)).toContain(
      'width:25%',
    )
  })
})
