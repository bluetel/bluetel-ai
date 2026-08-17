import { describe, expect, it } from 'vitest'

import {
  ARTIFACT_LOCATIONS,
  isDeclaredArtifact,
  isScopeSubset,
  locationOf,
  matchesGlob,
  SUBSET_NAMES,
  type ScopeSubset,
} from './patterns'

describe('matchesGlob', () => {
  it('keeps `*` within one segment', () => {
    expect(
      matchesGlob('tooling/skills/catalog/*/SKILL.md', 'tooling/skills/catalog/x/SKILL.md'),
    ).toBe(true)
    expect(
      matchesGlob('tooling/skills/catalog/*/SKILL.md', 'tooling/skills/catalog/x/y/SKILL.md'),
    ).toBe(false)
  })

  it('lets `**` cross segments, including zero of them', () => {
    const glob = 'tooling/skills/catalog/*/references/**/*.md'
    expect(matchesGlob(glob, 'tooling/skills/catalog/x/references/a.md')).toBe(true)
    expect(matchesGlob(glob, 'tooling/skills/catalog/x/references/deep/a.md')).toBe(true)
    expect(matchesGlob(glob, 'tooling/skills/catalog/x/references/a/b/c.md')).toBe(true)
  })

  it('escapes regex metacharacters in literal segments', () => {
    expect(matchesGlob('.specify/memory/constitution.md', '.specify/memory/constitution.md')).toBe(
      true,
    )
    expect(matchesGlob('.specify/memory/constitution.md', '-specify/memory/constitution-md')).toBe(
      false,
    )
  })

  it('anchors both ends', () => {
    expect(matchesGlob('AGENTS.md', 'docs/AGENTS.md')).toBe(false)
    expect(matchesGlob('AGENTS.md', 'AGENTS.md.bak')).toBe(false)
  })
})

describe('the declared artifact set', () => {
  it('includes every location FR-002 names', () => {
    const declared = [
      'tooling/skills/catalog/review/SKILL.md',
      'tooling/skills/catalog/review/skill.meta',
      'tooling/skills/catalog/review/references/diff-scope.md',
      '.agents/skills/review/SKILL.md',
      '.claude/skills/review/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/rules/typescript-conventions.md',
      '.agents/remote-workflow-instructions.md',
      '.specify/templates/plan-template.md',
      '.specify/memory/constitution.md',
    ]
    for (const path of declared) expect(isDeclaredArtifact(path)).toBe(true)
  })

  it('excludes `specs/**` — a spec is a record, not something an agent executes (R1)', () => {
    // Gating records has a cost with no matching benefit: `specs/004-…/checklists/
    // requirements.md` contains the literal line `- [x] No [NEEDS CLARIFICATION] markers
    // remain`, which a placeholder rule would report forever.
    expect(isDeclaredArtifact('specs/005-prompt-quality-validator/spec.md')).toBe(false)
    expect(
      isDeclaredArtifact('specs/004-remove-reachability-gate/checklists/requirements.md'),
    ).toBe(false)
  })

  it('excludes source code and this project’s own files', () => {
    for (const path of [
      'tooling/prompt-lint/src/gate.ts',
      'tooling/skills/lib/skills.sh',
      'package.json',
      'README.md',
      'tooling/prompt-lint/docs/rules.md',
    ]) {
      expect(isDeclaredArtifact(path)).toBe(false)
    }
  })

  it('gives every location a non-empty reason — FR-001 requires the set be explainable', () => {
    for (const location of ARTIFACT_LOCATIONS) {
      expect(location.reason.trim().length).toBeGreaterThan(0)
      expect(location.subsets.length).toBeGreaterThan(0)
    }
  })

  it('resolves every subset name to at least one location', () => {
    for (const subset of SUBSET_NAMES) {
      const matching = ARTIFACT_LOCATIONS.filter((location) => location.subsets.includes(subset))
      expect(matching.length).toBeGreaterThan(0)
    }
  })

  it('narrows to one subset when asked', () => {
    expect(isDeclaredArtifact('AGENTS.md', 'guidance')).toBe(true)
    expect(isDeclaredArtifact('AGENTS.md', 'catalog')).toBe(false)
    expect(isDeclaredArtifact('tooling/skills/catalog/x/SKILL.md', 'catalog')).toBe(true)
  })

  it('reports which location a path matched, so an exclusion can be explained', () => {
    expect(locationOf('CLAUDE.md')?.glob).toBe('CLAUDE.md')
    expect(locationOf('nothing/here.md')).toBeNull()
  })
})

describe('isScopeSubset', () => {
  it('accepts the four documented names', () => {
    for (const name of ['catalog', 'installed', 'guidance', 'speckit']) {
      expect(isScopeSubset(name)).toBe(true)
    }
  })

  it('rejects an unknown name — that is exit 2, not a silent full run', () => {
    expect(isScopeSubset('everything')).toBe(false)
    expect(isScopeSubset('')).toBe(false)
  })

  it('narrows the type', () => {
    const name = 'catalog'
    if (!isScopeSubset(name)) throw new Error('unreachable')
    const subset: ScopeSubset = name
    expect(subset).toBe('catalog')
  })
})
