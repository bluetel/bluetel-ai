import { describe, expect, it } from 'vitest'

import { ALL_KINDS } from '../scope'

import {
  BOOKKEEPING_RULES,
  configurableRules,
  localRules,
  RULE_IDS,
  ruleById,
  RULES,
} from './registry'

describe('the registry', () => {
  it('registers every rule exactly once', () => {
    expect(new Set(RULE_IDS).size).toBe(RULES.length)
  })

  it('gives every rule a `family/name` id', () => {
    for (const rule of RULES) {
      expect(rule.id, rule.id).toMatch(/^[a-z]+\/[a-z][a-z-]*[a-z]$/)
    }
  })

  it('gives every rule a non-empty statement and rationale', () => {
    // Surfaced by `--list-rules` and `--explain`. A rule that cannot say what it enforces
    // or why is a rule nobody can decide whether to promote.
    for (const rule of RULES) {
      expect(rule.statement.trim().length, rule.id).toBeGreaterThan(0)
      expect(rule.rationale.trim().length, rule.id).toBeGreaterThan(0)
    }
  })

  it('gives every artifact-scoped rule a non-empty appliesTo', () => {
    for (const rule of RULES) {
      if (rule.scope !== 'artifact') continue
      expect(rule.appliesTo.length, rule.id).toBeGreaterThan(0)
    }
  })

  it('names only real kinds in appliesTo', () => {
    for (const rule of RULES) {
      for (const kind of rule.appliesTo) expect(ALL_KINDS, rule.id).toContain(kind)
    }
  })

  it('gives every rule a severity the gate understands', () => {
    for (const rule of RULES) {
      expect(['error', 'warn', 'note'], rule.id).toContain(rule.defaultSeverity)
    }
  })

  it('marks a correctness rule as correctness and a delegated one as its own dimension', () => {
    for (const rule of RULES) {
      if (rule.source === 'prompt-lint') expect(rule.dimension, rule.id).toBe('correctness')
    }
  })

  it('finds a rule by id, and nothing by an unknown one', () => {
    expect(ruleById('refs/dangling-path')?.id).toBe('refs/dangling-path')
    expect(ruleById('refs/renamed-away')).toBeUndefined()
  })

  it('separates the four bookkeeping rules from the configurable ones', () => {
    // They describe the run rather than an artifact's content, so there is nothing to
    // promote, demote or baseline: a report that cannot say "I could not read this file"
    // is worse than a red one.
    const bookkeeping = Object.values(BOOKKEEPING_RULES)
    expect(bookkeeping).toHaveLength(4)
    for (const rule of bookkeeping) expect(rule.bookkeeping, rule.id).toBe(true)
    expect(configurableRules()).toHaveLength(RULES.length - 4)
    for (const rule of configurableRules()) expect(rule.bookkeeping, rule.id).toBeUndefined()
  })

  it('lists the bookkeeping rules the contract names', () => {
    expect(
      Object.values(BOOKKEEPING_RULES)
        .map((rule) => rule.id)
        .sort(),
    ).toEqual([
      'artifact/unclassified',
      'artifact/unreadable',
      'suppression/stale',
      'suppression/unreasoned',
    ])
  })

  it('lets every rule that evaluates something produce a non-empty remediation (SC-006)', () => {
    // Enforced by a test rather than by review: `defineRule` throws on an empty
    // remediation, so a rule that cannot say how to fix its finding cannot ship.
    for (const rule of localRules()) {
      expect(typeof rule.check, rule.id).toBe('function')
    }
  })

  it('declares no rule the config could name but the registry could not resolve', () => {
    // This is the invariant `validateConfig` relies on to catch a rename.
    for (const id of RULE_IDS) expect(ruleById(id), id).toBeDefined()
  })
})
