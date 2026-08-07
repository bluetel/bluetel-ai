import { describe, expect, it } from 'vitest'

import { fieldControlVariants } from './field-control-variants'

describe('fieldControlVariants', () => {
  it('sits on paper inside a control-weight hairline at the instrument radius', () => {
    const classes = fieldControlVariants({})
    expect(classes).toContain('bg-paper')
    expect(classes).toContain('border-hairline-hi')
    expect(classes).toContain('rounded-sm')
    expect(classes).not.toContain('rounded-full')
  })

  it('focuses to a signal border plus a signal-wash ring', () => {
    const classes = fieldControlVariants({})
    expect(classes).toContain('focus:border-signal')
    expect(classes).toContain('focus:ring-signal-wash')
  })

  it('suppresses the user-agent outline, so only one focus treatment shows', () => {
    expect(fieldControlVariants({})).toContain('focus:outline-none')
  })

  it('is valid by default', () => {
    expect(fieldControlVariants({})).toBe(fieldControlVariants({ invalid: false }))
    expect(fieldControlVariants({})).not.toContain('border-rust')
  })

  it('holds the rust border through hover and focus once the value is refused', () => {
    const classes = fieldControlVariants({ invalid: true })
    expect(classes).toContain('border-rust')
    expect(classes).toContain('hover:border-rust')
    expect(classes).toContain('focus:border-rust')
  })

  it('uses body type, because a value a person typed is not machine output', () => {
    expect(fieldControlVariants({})).toContain('type-body')
  })
})
