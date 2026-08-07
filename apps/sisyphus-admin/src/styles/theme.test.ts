import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SISYPHUS_CONTENT_GLOBS, sisyphusTheme } from './theme'

const designDocument = readFileSync(
  fileURLToPath(new URL('../../DESIGN.md', import.meta.url)),
  'utf8',
)

/**
 * Pull one flat front-matter group out of `DESIGN.md`.
 *
 * The test reads the document rather than a copy of it on purpose: `DESIGN.md` is the precedence
 * root (FR-021), so a token added there and not wired into the theme should fail here rather than
 * be discovered when a component reaches for a class that does not exist.
 */
const frontMatterGroup = (group: string): string[] => {
  const body = new RegExp(`^${group}:\\n((?:  \\S.*\\n)+)`, 'm').exec(designDocument)?.[1]
  if (body === undefined) throw new Error(`DESIGN.md has no '${group}:' front-matter group`)
  return [...body.matchAll(/^ {2}([\w-]+):/gm)].map(([, name]) => name)
}

describe('sisyphusTheme colours', () => {
  const designColours = frontMatterGroup('colors')
  const lightColours = designColours.filter((name) => !name.endsWith('-dark'))

  it('covers every light-theme colour DESIGN.md declares', () => {
    expect(lightColours.length).toBeGreaterThan(0)
    for (const name of lightColours) {
      expect(sisyphusTheme.colors).toHaveProperty([name])
    }
  })

  it('names no `-dark` twin, because the theme layer selects a set and components never do', () => {
    for (const name of Object.keys(sisyphusTheme.colors)) {
      expect(name.endsWith('-dark')).toBe(false)
    }
  })

  it('resolves every colour through a CSS variable rather than a literal', () => {
    const keywords = new Set(['transparent', 'currentColor', 'inherit'])
    for (const value of Object.values(sisyphusTheme.colors)) {
      if (keywords.has(value)) continue
      expect(value).toMatch(/^var\(--color-[a-z0-9-]+\)$/)
    }
  })

  it('publishes the three state colours, which are the ones locked to machine state', () => {
    expect(sisyphusTheme.colors).toMatchObject({
      amber: 'var(--color-amber)',
      verdigris: 'var(--color-verdigris)',
      rust: 'var(--color-rust)',
    })
  })
})

describe('sisyphusTheme scales', () => {
  it('exposes exactly the eight named spacing steps, plus zero', () => {
    expect(Object.keys(sisyphusTheme.spacing).sort()).toStrictEqual(
      ['0', 'band', 'close', 'default', 'gutter', 'hair', 'section', 'tight'].sort(),
    )
  })

  it('replaces the default spacing scale, so no numeric step survives to be reached for', () => {
    expect(sisyphusTheme.spacing).not.toHaveProperty(['4'])
    expect(sisyphusTheme.spacing).not.toHaveProperty(['px'])
  })

  it('exposes exactly the seven typography tokens', () => {
    expect(Object.keys(sisyphusTheme.fontSize).sort()).toStrictEqual([
      'body',
      'code',
      'data-mono',
      'display',
      'heading',
      'label-button',
      'label-mono',
    ])
  })

  it('carries line height and weight on every type token, so a size is never set alone', () => {
    for (const [size, extras] of Object.values(sisyphusTheme.fontSize)) {
      expect(size).toMatch(/^(var\(--type-|clamp)/)
      expect(extras.lineHeight).toMatch(/^var\(--type-/)
      expect(extras.fontWeight).toMatch(/^var\(--type-/)
    }
  })

  it('offers three radii plus the chip pair, and no pill', () => {
    expect(Object.keys(sisyphusTheme.borderRadius).sort()).toStrictEqual([
      'DEFAULT',
      'chip',
      'led',
      'lg',
      'md',
      'none',
      'sm',
    ])
    expect(sisyphusTheme.borderRadius).not.toHaveProperty(['full'])
  })

  it('keeps border width to a single hairline, so hierarchy is carried by colour', () => {
    expect(Object.keys(sisyphusTheme.borderWidth).sort()).toStrictEqual(['0', 'DEFAULT'])
    expect(sisyphusTheme.borderWidth.DEFAULT).toBe('var(--border-hairline-width)')
  })

  it('offers exactly one elevation step, and keeps the keycap shades out of it', () => {
    const elevation = Object.entries(sisyphusTheme.boxShadow).filter(
      ([name, value]) => name !== 'none' && !value.startsWith('inset'),
    )
    expect(elevation).toStrictEqual([['raised', 'var(--shadow-raised)']])
  })
})

describe('sisyphusTheme motion', () => {
  it('names the two durations and the single easing curve', () => {
    expect(sisyphusTheme.extend.transitionDuration).toStrictEqual({
      state: 'var(--motion-state)',
      press: 'var(--motion-press)',
    })
    expect(Object.keys(sisyphusTheme.extend.transitionTimingFunction)).toStrictEqual(['panel'])
  })

  it('declares the LED pulse as the only looping animation', () => {
    expect(Object.keys(sisyphusTheme.extend.animation)).toStrictEqual(['led-pulse'])
    expect(sisyphusTheme.extend.animation['led-pulse']).toContain('infinite')
  })
})

describe('SISYPHUS_CONTENT_GLOBS', () => {
  it('scans the panel source so a class only used in a primitive is still generated', () => {
    expect(SISYPHUS_CONTENT_GLOBS).toStrictEqual(['./src/**/*.{ts,tsx}'])
  })
})
