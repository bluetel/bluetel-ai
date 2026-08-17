import { describe, expect, it } from 'vitest'

import { classify, skillNameOf, skillRootOf } from './classify'

describe('classify', () => {
  it.each([
    ['tooling/skills/catalog/review/SKILL.md', 'catalog-skill'],
    ['tooling/skills/catalog/review/skill.meta', 'catalog-meta'],
    ['tooling/skills/catalog/review/references/diff-scope.md', 'catalog-reference'],
    ['tooling/skills/catalog/review/references/deep/nested.md', 'catalog-reference'],
    ['.agents/skills/review/SKILL.md', 'installed-skill'],
    ['.claude/skills/review/SKILL.md', 'agent-pointer'],
    ['AGENTS.md', 'guidance'],
    ['CLAUDE.md', 'guidance'],
    ['.claude/rules/typescript-conventions.md', 'guidance'],
    ['.agents/remote-workflow-instructions.md', 'guidance'],
    ['.specify/templates/plan-template.md', 'speckit-template'],
    ['.specify/memory/constitution.md', 'constitution'],
  ])('classifies %s as %s', (path, kind) => {
    expect(classify(path)).toBe(kind)
  })

  it('returns null for a path outside the declared set', () => {
    // Out of scope is not the same thing as `unclassified`, and conflating the two would
    // make every source file in the repository a finding.
    expect(classify('tooling/prompt-lint/src/gate.ts')).toBeNull()
    expect(classify('specs/005-prompt-quality-validator/spec.md')).toBeNull()
  })

  it('classifies an installed non-SKILL markdown file as installed-skill', () => {
    expect(classify('.agents/skills/review/references/personas.md')).toBe('installed-skill')
  })

  it('does not let the installed tree fall through to guidance', () => {
    // `.agents/*.md` is guidance and `.agents/skills/**` is not; an ordering mistake here
    // would run guidance rules over 17 installed skill trees.
    expect(classify('.agents/skills/review/SKILL.md')).toBe('installed-skill')
  })
})

describe('skillRootOf', () => {
  it('finds the root for each of the three skill trees', () => {
    expect(skillRootOf('tooling/skills/catalog/review/references/x.md')).toBe(
      'tooling/skills/catalog/review',
    )
    expect(skillRootOf('.agents/skills/review/SKILL.md')).toBe('.agents/skills/review')
    expect(skillRootOf('.claude/skills/review/SKILL.md')).toBe('.claude/skills/review')
  })

  it('is null for an artifact that is not part of a skill', () => {
    expect(skillRootOf('AGENTS.md')).toBeNull()
    expect(skillRootOf('.specify/memory/constitution.md')).toBeNull()
  })
})

describe('skillNameOf', () => {
  it('pairs the two trees a cross-tree rule compares', () => {
    expect(skillNameOf('tooling/skills/catalog/review/SKILL.md')).toBe('review')
    expect(skillNameOf('.agents/skills/review/SKILL.md')).toBe('review')
  })

  it('is null outside a skill tree', () => {
    expect(skillNameOf('CLAUDE.md')).toBeNull()
  })
})
