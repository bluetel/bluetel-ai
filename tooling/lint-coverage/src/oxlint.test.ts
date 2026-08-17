import { describe, it, expect } from 'vitest'

import { bareRuleName, findSilentOxlintRules } from './oxlint'
import type { MaterialisedFixture } from './parity'

describe('bareRuleName', () => {
  it('strips oxlint‘s plugin parentheses', () => {
    expect(bareRuleName('typescript(no-floating-promises)')).toBe('no-floating-promises')
    expect(bareRuleName('eslint(no-undef)')).toBe('no-undef')
    expect(bareRuleName('bluetel-ai(enforce-safe-env)')).toBe('enforce-safe-env')
  })

  it('strips ESLint‘s plugin prefix', () => {
    expect(bareRuleName('@typescript-eslint/no-floating-promises')).toBe('no-floating-promises')
    expect(bareRuleName('import-x/order')).toBe('order')
    expect(bareRuleName('prefer-arrow-functions/prefer-arrow-functions')).toBe(
      'prefer-arrow-functions',
    )
  })

  it('leaves an unnamespaced core rule alone', () => {
    expect(bareRuleName('no-useless-return')).toBe('no-useless-return')
  })

  it('makes the two layers agree on the same rule', () => {
    expect(bareRuleName('@typescript-eslint/no-unsafe-call')).toBe(
      bareRuleName('typescript(no-unsafe-call)'),
    )
  })
})

const materialised = (rule: string, filename: string): MaterialisedFixture => ({
  fixture: { rule, filename, code: '' },
  file: `/tmp/${filename}`,
})

describe('findSilentOxlintRules', () => {
  const fixtures = [
    materialised('@typescript-eslint/no-floating-promises', 'a.ts'),
    materialised('@cspell/spellchecker', 'b.ts'),
  ]
  const ownedByOxlint = (rule: string) => rule !== '@cspell/spellchecker'

  it('reports nothing when every oxlint-owned rule fired', () => {
    const reported = new Map([['a.ts', new Set(['no-floating-promises'])]])
    expect(findSilentOxlintRules(fixtures, reported, ownedByOxlint)).toEqual([])
  })

  it('reports a rule that fired nothing at all', () => {
    expect(findSilentOxlintRules(fixtures, new Map(), ownedByOxlint)).toEqual([
      {
        rule: '@typescript-eslint/no-floating-promises',
        file: 'a.ts',
        reportedInstead: [],
      },
    ])
  })

  it('reports a rule whose fixture tripped a different rule instead', () => {
    const reported = new Map([['a.ts', new Set(['no-unsafe-call'])]])
    expect(findSilentOxlintRules(fixtures, reported, ownedByOxlint)).toEqual([
      {
        rule: '@typescript-eslint/no-floating-promises',
        file: 'a.ts',
        reportedInstead: ['no-unsafe-call'],
      },
    ])
  })

  it('does not blame oxlint for a rule ESLint owns', () => {
    expect(
      findSilentOxlintRules(fixtures, new Map(), ownedByOxlint).map((f) => f.rule),
    ).not.toContain('@cspell/spellchecker')
  })
})
