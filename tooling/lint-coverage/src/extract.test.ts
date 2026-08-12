import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { extractRules, summarise } from './extract'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixtureConfig = path.join(packageRoot, 'fixtures', 'eslint.fixture.config.mjs')

const probeFiles = ['probe.ts', 'probe.mjs']

const extractFixture = async () =>
  extractRules({
    cwd: packageRoot,
    files: probeFiles,
    overrideConfigFile: fixtureConfig,
  })

describe('extractRules', () => {
  it('finds exactly the rules the fixture config enables', async () => {
    const rules = await extractFixture()

    expect(rules.map((rule) => rule.name)).toEqual([
      '@typescript-eslint/consistent-type-imports',
      '@typescript-eslint/no-explicit-any',
      '@typescript-eslint/no-floating-promises',
      'arrow-body-style',
      'no-useless-return',
    ])
  })

  it('does not count a rule that is explicitly off', async () => {
    const rules = await extractFixture()

    expect(rules.map((rule) => rule.name)).not.toContain('@typescript-eslint/no-non-null-assertion')
  })

  it('classifies a type-aware rule from the rule meta, not from a hand-kept list', async () => {
    const rules = await extractFixture()
    const floatingPromises = rules.find(
      (rule) => rule.name === '@typescript-eslint/no-floating-promises',
    )

    expect(floatingPromises?.requiresTypeChecking).toBe(true)
  })

  it('classifies a syntactic rule as not needing types', async () => {
    const rules = await extractFixture()
    const consistentTypeImports = rules.find(
      (rule) => rule.name === '@typescript-eslint/consistent-type-imports',
    )

    expect(consistentTypeImports?.requiresTypeChecking).toBe(false)
    expect(consistentTypeImports?.fixable).toBe(true)
  })

  it('records severity, options and owning plugin', async () => {
    const rules = await extractFixture()

    expect(rules.find((rule) => rule.name === 'arrow-body-style')).toMatchObject({
      plugin: 'eslint',
      severity: 'error',
      options: ['as-needed'],
    })
    expect(rules.find((rule) => rule.name === '@typescript-eslint/no-explicit-any')).toMatchObject({
      plugin: '@typescript-eslint',
      severity: 'warn',
      options: [],
    })
  })

  it('records which probe files a rule is scoped to', async () => {
    const rules = await extractFixture()

    expect(rules.find((rule) => rule.name === 'no-useless-return')?.enabledFor).toEqual(probeFiles)
    expect(
      rules.find((rule) => rule.name === '@typescript-eslint/no-floating-promises')?.enabledFor,
    ).toEqual(['probe.ts'])
  })

  it('sorts by rule name so successive runs diff cleanly', async () => {
    const rules = await extractFixture()
    const names = rules.map((rule) => rule.name)

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})

describe('summarise', () => {
  it('splits the rule set by whether each rule needs type information', async () => {
    const totals = summarise(await extractFixture())

    expect(totals.total).toBe(5)
    expect(totals.typeAware).toBe(1)
    expect(totals.syntactic).toBe(4)
    expect(totals.byPlugin).toEqual({ '@typescript-eslint': 3, eslint: 2 })
  })
})
