import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  ESLINT_WORKSPACE_RULES,
  OXLINT_JS_PLUGIN_RULES,
  isOxlintOwned,
  oxlintEnforcedRules,
  readOxlintConfig,
} from './owners'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.dirname(path.dirname(packageRoot))

describe('ESLINT_WORKSPACE_RULES', () => {
  it('gives every rule that stays behind a stated reason', () => {
    for (const [rule, reason] of Object.entries(ESLINT_WORKSPACE_RULES)) {
      expect(reason, `${rule} has no reason`).toBeTruthy()
    }
  })

  it('is a short list — the migration is the default, staying behind is the exception', () => {
    expect(Object.keys(ESLINT_WORKSPACE_RULES)).toHaveLength(4)
  })
})

describe('oxlintEnforcedRules', () => {
  const enforced = oxlintEnforcedRules(readOxlintConfig(repoRoot))

  it('reads the committed config rather than restating it', () => {
    expect(enforced.size).toBeGreaterThan(100)
  })

  it('includes the type-aware rules', () => {
    expect(enforced.has('no-floating-promises')).toBe(true)
    expect(enforced.has('no-misused-promises')).toBe(true)
    expect(enforced.has('restrict-template-expressions')).toBe(true)
  })

  it('includes every rule routed through the JS plugin API', () => {
    for (const alias of Object.values(OXLINT_JS_PLUGIN_RULES)) {
      expect(alias).toBeDefined()
      const bare = (alias ?? '').slice((alias ?? '').lastIndexOf('/') + 1)
      expect(enforced.has(bare), alias).toBe(true)
    }
  })

  it('does not include the rules that stayed with ESLint', () => {
    expect(enforced.has('spellchecker')).toBe(false)
    expect(enforced.has('enforce-module-boundaries')).toBe(false)
    expect(enforced.has('no-octal')).toBe(false)
    expect(enforced.has('no-dupe-args')).toBe(false)
  })
})

describe('isOxlintOwned', () => {
  const enforced = oxlintEnforcedRules(readOxlintConfig(repoRoot))

  it('claims a rule oxlint enforces', () => {
    expect(isOxlintOwned('@typescript-eslint/no-floating-promises', enforced)).toBe(true)
    expect(isOxlintOwned('arrow-body-style', enforced)).toBe(true)
  })

  it('never claims a rule that stayed with ESLint, even if a name would match', () => {
    for (const rule of Object.keys(ESLINT_WORKSPACE_RULES)) {
      expect(isOxlintOwned(rule, enforced), rule).toBe(false)
    }
  })

  it('does not claim a rule nobody enforces', () => {
    expect(isOxlintOwned('@typescript-eslint/no-such-rule', enforced)).toBe(false)
  })
})
