import { describe, expect, it } from 'vitest'

import { buttonVariants } from './button-variants'
import { FOCUS_RING } from './focus-ring'

const VARIANTS = ['primary', 'secondary', 'quiet', 'danger'] as const

describe('buttonVariants', () => {
  it.each(VARIANTS)('%s composes in the shared focus ring', (variant) => {
    expect(buttonVariants({ variant })).toContain(FOCUS_RING)
  })

  it.each(VARIANTS)(
    '%s sets the button label in sentence-case sans, never uppercase mono',
    (variant) => {
      const classes = buttonVariants({ variant })
      expect(classes).toContain('type-label-button')
      expect(classes).not.toContain('type-label-mono')
      expect(classes).not.toContain('uppercase')
    },
  )

  it.each(VARIANTS)('%s uses the instrument radius, never a pill', (variant) => {
    expect(buttonVariants({ variant })).toContain('rounded-sm')
    expect(buttonVariants({ variant })).not.toContain('rounded-full')
  })

  it.each(VARIANTS)('%s adds no hover lift, glow or gradient', (variant) => {
    expect(buttonVariants({ variant })).not.toMatch(
      /hover:-translate|hover:scale|hover:shadow-raised|blur|gradient/,
    )
  })

  it('gives the primary key its 2px inset shade and compresses it on press', () => {
    const classes = buttonVariants({ variant: 'primary' })
    expect(classes).toContain('shadow-keycap')
    expect(classes).toContain('enabled:active:shadow-keycap-pressed')
    expect(classes).toContain('enabled:active:translate-y-press')
  })

  it('gives the secondary key the hairline shade DESIGN.md specifies for it', () => {
    const classes = buttonVariants({ variant: 'secondary' })
    expect(classes).toContain('shadow-keycap-hairline')
    expect(classes).toContain('border-hairline-hi')
  })

  it('leaves the quiet variant with no fill and no border of its own', () => {
    const classes = buttonVariants({ variant: 'quiet' })
    expect(classes).toContain('text-graphite')
    expect(classes).toMatch(/enabled:hover:bg-signal-wash/)
    expect(classes).not.toMatch(/(?<!enabled:hover:)\bbg-(?!transparent)/)
  })

  it('fills the danger variant with rust only on hover', () => {
    const classes = buttonVariants({ variant: 'danger' })
    expect(classes).toContain('text-rust')
    expect(classes).toContain('border-rust')
    expect(classes).toContain('enabled:hover:bg-rust')
  })

  it.each(VARIANTS)('%s suppresses press travel while disabled', (variant) => {
    const classes = buttonVariants({ variant })
    expect(classes).toContain('disabled:shadow-none')
    expect(classes).toContain('enabled:active:translate-y-press')
    expect(classes).not.toMatch(/(?<!enabled:)active:translate/)
  })

  it('defaults to secondary, because only one primary is allowed per view', () => {
    expect(buttonVariants({})).toBe(buttonVariants({ variant: 'secondary' }))
  })

  it('moves on the two named durations and the single easing curve', () => {
    const classes = buttonVariants({ variant: 'primary' })
    expect(classes).toContain('duration-state')
    expect(classes).toContain('enabled:active:duration-press')
    expect(classes).toContain('ease-panel')
  })
})
