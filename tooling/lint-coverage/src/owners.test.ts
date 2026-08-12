import { describe, it, expect } from 'vitest'

import type { ExtractedRule } from './extract'
import { ESLINT_WORKSPACE_RULES, postMigrationAssignment, preMigrationAssignment } from './owners'

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

describe('preMigrationAssignment', () => {
  it('assigns every rule to the single ESLint layer', () => {
    expect(preMigrationAssignment()).toMatchObject({ owner: 'eslint', status: 'covered' })
  })

  it('says the same thing for every rule, because today one layer runs them all', () => {
    expect(preMigrationAssignment()).toEqual(preMigrationAssignment())
  })
})

describe('postMigrationAssignment', () => {
  it('keeps the two workspace-scoped rules with ESLint, each with a stated reason', () => {
    for (const name of Object.keys(ESLINT_WORKSPACE_RULES)) {
      const assignment = postMigrationAssignment(rule({ name }))
      expect(assignment.owner).toBe('eslint-workspace')
      expect(assignment.status).toBe('relocated')
      expect(assignment.notes).toBeTruthy()
    }
  })

  it('sends a type-aware rule to the tsgolint layer', () => {
    expect(
      postMigrationAssignment(
        rule({ name: '@typescript-eslint/no-floating-promises', requiresTypeChecking: true }),
      ).owner,
    ).toBe('oxlint-type-aware')
  })

  it('sends everything else to a native oxlint rule', () => {
    expect(postMigrationAssignment(rule()).owner).toBe('oxlint-native')
  })

  it('never leaves a rule unassigned or dropped', () => {
    const samples = [
      rule(),
      rule({ name: '@cspell/spellchecker', plugin: '@cspell' }),
      rule({ name: '@nx/enforce-module-boundaries', plugin: '@nx' }),
      rule({ name: '@typescript-eslint/no-misused-promises', requiresTypeChecking: true }),
    ]

    for (const sample of samples) {
      const assignment = postMigrationAssignment(sample)
      expect(assignment.owner).not.toBe('unassigned')
      expect(assignment.status).not.toBe('dropped')
    }
  })
})
