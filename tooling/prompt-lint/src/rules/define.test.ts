import { describe, expect, it } from 'vitest'

import { artifactFixture, contextFixture } from '../test-helpers'

import {
  appliesToKind,
  defineDelegatedRule,
  defineRule,
  requireArtifact,
  unmetNeeds,
  type RuleInput,
} from './define'

const declaration = {
  id: 'test/example' as const,
  defaultSeverity: 'warn' as const,
  statement: 'A test rule.',
  rationale: 'To prove the seam works.',
  appliesTo: ['catalog-skill' as const],
  dimension: 'correctness' as const,
  scope: 'artifact' as const,
}

const inputFor = (artifact: RuleInput['artifact']): RuleInput => ({
  ...contextFixture(),
  artifact,
})

describe('defineRule', () => {
  it('supplies the rule id, the default severity and the artifact’s path', () => {
    // These three fields repeated across twenty modules are the duplication the seam
    // exists to remove (Constitution IV), so the rule module never writes them.
    const rule = defineRule(declaration, () => [{ message: 'wrong', remediation: 'fix it' }])
    const [finding] = rule.check(inputFor(artifactFixture({ path: 'a/SKILL.md' })))

    expect(finding).toEqual({
      rule: 'test/example',
      severity: 'warn',
      path: 'a/SKILL.md',
      line: 0,
      related: [],
      message: 'wrong',
      remediation: 'fix it',
    })
  })

  it('marks it as this repository’s own rule and keeps the declaration', () => {
    const rule = defineRule(declaration, () => [])
    expect(rule.source).toBe('prompt-lint')
    expect(rule.statement).toBe('A test rule.')
  })

  it('passes line, column, bundle and related through', () => {
    const rule = defineRule(declaration, () => [
      {
        line: 12,
        column: 4,
        bundle: 'skill:x',
        related: [{ path: 'b.md', line: 3 }],
        message: 'm',
        remediation: 'r',
      },
    ])
    expect(rule.check(inputFor(artifactFixture()))[0]).toMatchObject({
      line: 12,
      column: 4,
      bundle: 'skill:x',
      related: [{ path: 'b.md', line: 3 }],
    })
  })

  it('omits column and bundle entirely when unset, so two runs serialise identically', () => {
    const rule = defineRule(declaration, () => [{ message: 'm', remediation: 'r' }])
    const finding = rule.check(inputFor(artifactFixture()))[0]
    expect(Object.keys(finding).sort()).toEqual([
      'line',
      'message',
      'path',
      'related',
      'remediation',
      'rule',
      'severity',
    ])
  })

  it('lets a set-scoped rule name its own path', () => {
    const rule = defineRule({ ...declaration, scope: 'set' }, () => [
      { path: 'elsewhere.md', message: 'm', remediation: 'r' },
    ])
    expect(rule.check(inputFor(null))[0].path).toBe('elsewhere.md')
  })

  it('throws when a finding has no path and no artifact — never a finding about nothing', () => {
    const rule = defineRule({ ...declaration, scope: 'set' }, () => [
      { message: 'm', remediation: 'r' },
    ])
    expect(() => rule.check(inputFor(null))).toThrow(/no path and no artifact/)
  })

  it('throws on an empty remediation (SC-006 as a runtime invariant)', () => {
    // A rule that cannot say how to fix its finding is a rule that trains people to
    // ignore it, so this fails loudly (exit 5) rather than shipping a bare complaint.
    const rule = defineRule(declaration, () => [{ message: 'm', remediation: '   ' }])
    expect(() => rule.check(inputFor(artifactFixture()))).toThrow(/empty remediation/)
  })

  it('returns no findings when the check finds nothing', () => {
    expect(defineRule(declaration, () => []).check(inputFor(artifactFixture()))).toEqual([])
  })
})

describe('defineDelegatedRule', () => {
  it('carries every property of a rule except a check body (FR-047)', () => {
    const rule = defineDelegatedRule({
      ...declaration,
      id: 'contextops/redundancy',
      dimension: 'redundancy',
      scope: 'bundle',
    })
    expect(rule.source).toBe('contextops')
    expect(rule.statement.length).toBeGreaterThan(0)
    expect(rule.rationale.length).toBeGreaterThan(0)
    expect('check' in rule).toBe(false)
  })
})

describe('appliesToKind', () => {
  it('is true only for a declared kind', () => {
    const rule = defineRule(declaration, () => [])
    expect(appliesToKind(rule, 'catalog-skill')).toBe(true)
    expect(appliesToKind(rule, 'guidance')).toBe(false)
  })
})

describe('unmetNeeds', () => {
  const needy = defineRule({ ...declaration, needs: ['content', 'view', 'meta'] }, () => [])

  it('is empty when the artifact satisfies every need', () => {
    const rule = defineRule({ ...declaration, needs: ['content', 'view'] }, () => [])
    expect(unmetNeeds(rule, artifactFixture())).toEqual([])
  })

  it('names every need an unreadable artifact cannot satisfy', () => {
    // The evaluator turns these into `notEvaluated` entries. A rule that silently
    // returned no findings here would be indistinguishable from one that passed.
    expect(unmetNeeds(needy, artifactFixture({ readError: 'not-utf8' }))).toEqual([
      'content',
      'view',
      'meta',
    ])
  })

  it('names only the missing view for a metadata file, which has no markdown body', () => {
    const rule = defineRule({ ...declaration, needs: ['content', 'view'] }, () => [])
    expect(
      unmetNeeds(rule, artifactFixture({ kind: 'catalog-meta', content: 'name=x\n' })),
    ).toEqual(['view'])
  })

  it('is empty for a rule that declares no needs', () => {
    expect(
      unmetNeeds(
        defineRule(declaration, () => []),
        artifactFixture({ readError: 'empty' }),
      ),
    ).toEqual([])
  })
})

describe('requireArtifact', () => {
  it('returns the artifact when there is one', () => {
    const artifact = artifactFixture()
    expect(requireArtifact(inputFor(artifact))).toBe(artifact)
  })

  it('throws rather than silently reporting nothing', () => {
    expect(() => requireArtifact(inputFor(null))).toThrow(/no artifact/)
  })
})
