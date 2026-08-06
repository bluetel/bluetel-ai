import { describe, expect, it } from 'vitest'

import { stateChipVariants } from './state-chip-variants'
import { STATE_TONES } from './workflow-state-presentation'

describe('stateChipVariants', () => {
  it.each(STATE_TONES)('colours the %s tone through a single text colour', (tone) => {
    expect(stateChipVariants({ tone })).toContain(`text-${tone}`)
  })

  it('varies only the text colour between tones, so the border and lamp cannot diverge', () => {
    const rust = stateChipVariants({ tone: 'rust' }).split(' ')
    const verdigris = stateChipVariants({ tone: 'verdigris' }).split(' ')
    expect(rust.filter((name) => !verdigris.includes(name))).toStrictEqual(['text-rust'])
    expect(verdigris.filter((name) => !rust.includes(name))).toStrictEqual(['text-verdigris'])
  })

  it('draws its border from currentColor rather than a token of its own', () => {
    expect(stateChipVariants({ tone: 'rust' })).toContain('border-current')
  })

  it('sits on paper at the chip radius, which is not a pill', () => {
    const classes = stateChipVariants({ tone: 'signal' })
    expect(classes).toContain('bg-paper')
    expect(classes).toContain('rounded-chip')
    expect(classes).not.toContain('rounded-full')
  })

  it('sets its readout in uppercase mono, which is what state is always set in', () => {
    expect(stateChipVariants({ tone: 'amber' })).toContain('type-label-mono')
  })

  it('separates the LED from the readout by the within-a-control step', () => {
    expect(stateChipVariants({ tone: 'amber' })).toContain('gap-tight')
  })

  it('defaults to graphite, so a chip with no state behind it reads as idle', () => {
    expect(stateChipVariants({})).toBe(stateChipVariants({ tone: 'graphite' }))
  })
})
