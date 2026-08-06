import { sisyphusTheme } from '@sisyphus-admin/styles/theme'
import { describe, expect, it } from 'vitest'

import { cn, NAMED_RADII, NAMED_SPACING } from './cn'

describe('cn', () => {
  it('joins plain class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy and conditional entries', () => {
    expect(cn('a', false, undefined, null, '', 'b')).toBe('a b')
    expect(cn('a', { b: true, c: false })).toBe('a b')
  })

  it('flattens arrays', () => {
    expect(cn(['a', ['b', 'c']])).toBe('a b c')
  })

  it('lets a later Tailwind utility override an earlier one in the same group', () => {
    // The whole reason the merge sits on top of clsx: without it both classes survive and the
    // winner is decided by stylesheet order rather than by call order.
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-ink', 'text-graphite')).toBe('text-graphite')
  })

  it('keeps utilities from different groups side by side', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2')
  })

  it('lets a caller-supplied className win over a variant default', () => {
    const variantClasses = 'rounded-sm px-4'
    expect(cn(variantClasses, 'px-8')).toBe('rounded-sm px-8')
  })

  it('returns an empty string when given nothing', () => {
    expect(cn()).toBe('')
  })
})

/**
 * The reason this utility is `extendTailwindMerge` rather than stock `twMerge`.
 *
 * Every case below returned *both* classes under the stock configuration, because the panel's
 * spacing and radius scales are **named** and the merger only knew Tailwind's numeric defaults.
 * Both classes landing means the winner is decided by stylesheet order — exactly what the merge
 * step exists to stop.
 */
describe('cn on the panel’s named scales', () => {
  it('lets a caller override a base padding step, the case stock twMerge got wrong', () => {
    expect(cn('p-close', 'p-default')).toBe('p-default')
  })

  it.each([
    ['px-close', 'px-section'],
    ['py-tight', 'py-band'],
    ['m-hair', 'm-gutter'],
    ['mt-close', 'mt-section'],
    ['gap-tight', 'gap-close'],
  ])('lets %s be displaced by %s', (base, override) => {
    expect(cn(base, override)).toBe(override)
  })

  it('still keeps two named steps that do not conflict', () => {
    expect(cn('px-close', 'py-default')).toBe('px-close py-default')
    expect(cn('p-close', 'gap-tight')).toBe('p-close gap-tight')
  })

  it('lets a caller override a named radius, including the instrument radii', () => {
    expect(cn('rounded-md', 'rounded-sm')).toBe('rounded-sm')
    expect(cn('rounded-md', 'rounded-chip')).toBe('rounded-chip')
    expect(cn('rounded-chip', 'rounded-led')).toBe('rounded-led')
  })

  it('reproduces the primitive case: a card body’s padding yielding to a caller’s', () => {
    // `CardBody` composes `type-body p-default`; a caller asking for a denser well must win.
    expect(cn('type-body p-default', 'p-close')).toBe('type-body p-close')
  })
})

/**
 * The scales are restated in `cn.ts` so the Tailwind config stays out of the client bundle. This
 * is what stops the restatement drifting: a step added to the theme and not to `cn.ts` silently
 * stops merging, and this is where that is caught.
 */
describe('the named scales taught to the merger', () => {
  it('covers every spacing step the theme declares', () => {
    expect([...NAMED_SPACING].sort()).toStrictEqual(Object.keys(sisyphusTheme.spacing).sort())
  })

  it('covers every radius the theme declares, apart from the bare `rounded` default', () => {
    expect([...NAMED_RADII].sort()).toStrictEqual(
      Object.keys(sisyphusTheme.borderRadius)
        .filter((name) => name !== 'DEFAULT')
        .sort(),
    )
  })

  it('declares no pill radius, because nothing in this system is fully rounded', () => {
    expect([...NAMED_RADII]).not.toContain('full')
  })
})
