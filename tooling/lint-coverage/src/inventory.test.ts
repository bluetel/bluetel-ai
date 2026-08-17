import { describe, it, expect } from 'vitest'

import type { ExtractedRule } from './extract'
import { renderInventory, type RuleAssignment } from './inventory'

const rule = (overrides: Partial<ExtractedRule> = {}): ExtractedRule => ({
  name: 'no-useless-return',
  plugin: 'eslint',
  severity: 'error',
  options: [],
  requiresTypeChecking: false,
  fixable: true,
  enabledFor: ['probe.ts'],
  ...overrides,
})

const covered: RuleAssignment = { owner: 'oxlint-native', status: 'covered' }
const unassigned: RuleAssignment = { owner: 'unassigned', status: 'unassigned' }

const generatedBy = 'pnpm lint-inventory'

describe('renderInventory', () => {
  it('emits one row per rule', () => {
    const markdown = renderInventory([rule(), rule({ name: 'arrow-body-style' })], () => covered, {
      generatedBy,
    })

    expect(markdown).toContain('| `no-useless-return` |')
    expect(markdown).toContain('| `arrow-body-style` |')
    expect(markdown).toContain('| Enabled rules | **2** |')
  })

  it('splits the totals by whether a rule needs type information', () => {
    const markdown = renderInventory(
      [
        rule(),
        rule({ name: '@typescript-eslint/no-floating-promises', requiresTypeChecking: true }),
      ],
      () => covered,
      { generatedBy },
    )

    expect(markdown).toContain('| Type-aware (`meta.docs.requiresTypeChecking`) | 1 |')
    expect(markdown).toContain('| Syntactic | 1 |')
  })

  it('makes an unassigned rule loud rather than absent', () => {
    const markdown = renderInventory([rule()], () => unassigned, { generatedBy })

    expect(markdown).toContain('| Unassigned | **1** |')
    expect(markdown).toContain('| unassigned | unassigned |')
  })

  it('reports zero unassigned and zero dropped without emphasis when the migration is complete', () => {
    const markdown = renderInventory([rule()], () => covered, { generatedBy })

    expect(markdown).toContain('| Unassigned | 0 |')
    expect(markdown).toContain('| Dropped | 0 |')
  })

  it('flags a count that disagrees with the figure recorded elsewhere', () => {
    const markdown = renderInventory([rule()], () => covered, {
      generatedBy,
      expectation: {
        label: 'Rules enabled for a TypeScript file',
        count: 1,
        expected: 129,
        source: '`research.md` §2',
      },
    })

    expect(markdown).toContain(
      '⚠️ Rules enabled for a TypeScript file is 1, not the 129 recorded in `research.md` §2',
    )
  })

  it('confirms a count that agrees with the figure recorded elsewhere', () => {
    const markdown = renderInventory([rule()], () => covered, {
      generatedBy,
      expectation: {
        label: 'Rules enabled for a TypeScript file',
        count: 129,
        expected: 129,
        source: '`research.md` §2',
      },
    })

    expect(markdown).toContain(
      'Rules enabled for a TypeScript file: **129**, matching `research.md` §2.',
    )
  })

  it('escapes pipes so an option value cannot break the table', () => {
    const markdown = renderInventory([rule({ options: [{ pattern: 'a|b' }] })], () => covered, {
      generatedBy,
    })

    expect(markdown).toContain('a\\|b')
  })

  it('truncates a very long option blob rather than emitting an unreadable row', () => {
    const long = { allowedNames: Array.from({ length: 40 }, (_, index) => `name-${String(index)}`) }
    const markdown = renderInventory([rule({ options: [long] })], () => covered, { generatedBy })

    expect(markdown).toContain('…`')
  })

  it('renders a bare severity as an em dash rather than an empty cell', () => {
    const markdown = renderInventory([rule()], () => covered, { generatedBy })

    expect(markdown).toContain('| error | — |')
  })

  it('groups the rule counts by plugin', () => {
    const markdown = renderInventory(
      [rule(), rule({ name: 'import-x/order', plugin: 'import-x' })],
      () => covered,
      { generatedBy },
    )

    expect(markdown).toContain('| `eslint` | 1 |')
    expect(markdown).toContain('| `import-x` | 1 |')
  })
})
