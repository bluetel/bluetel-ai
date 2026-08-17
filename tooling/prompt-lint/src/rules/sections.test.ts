import { describe, expect, it } from 'vitest'

import { artifactFixture, expectDoesNotFire, expectFires } from '../test-helpers'

import { sectionMissing } from './sections'

const body = (content: string, path = 'tooling/skills/catalog/x/SKILL.md') =>
  artifactFixture({ path, kind: 'catalog-skill', content, skillRoot: 'tooling/skills/catalog/x' })

describe('skill/section-missing', () => {
  it('fires on a body with no completion-criteria section', () => {
    const [finding] = expectFires(sectionMissing, body('# Skill\n\nDo the thing.\n'))
    expect(finding.line).toBe(1)
    expect(finding.message).toContain('No completion-criteria section')
    expect(finding.remediation).toContain('## Done When')
  })

  it('does not fire on the `## Done When` shape the speckit skills already model', () => {
    expectDoesNotFire(sectionMissing, body('# Skill\n\n## Done When\n\n- [ ] it works\n'))
  })

  it.each([
    '## Completion Criteria',
    '## Acceptance Criteria',
    '## Definition of Done',
    '## Success Criteria',
    '### done when',
  ])('accepts `%s` as equivalent', (heading) => {
    expectDoesNotFire(sectionMissing, body(`# Skill\n\n${heading}\n\n- [ ] x\n`))
  })

  it('does not fire on a reference document, which is prose rather than a procedure', () => {
    // The `installed-skill` kind covers the whole installed tree, so without the SKILL.md
    // guard this rule fires on every installed reference file — 8 findings on the first
    // real run, none of them a defect.
    expectDoesNotFire(
      sectionMissing,
      artifactFixture({
        path: '.agents/skills/copywriting/references/copy-frameworks.md',
        kind: 'installed-skill',
        content: '# Frameworks\n\nAIDA, PAS, BAB.\n',
        skillRoot: '.agents/skills/copywriting',
      }),
    )
  })

  it('does fire on an installed skill body', () => {
    expectFires(
      sectionMissing,
      artifactFixture({
        path: '.agents/skills/x/SKILL.md',
        kind: 'installed-skill',
        content: '# Skill\n\nDo the thing.\n',
        skillRoot: '.agents/skills/x',
      }),
    )
  })

  it('does not fire when the view could not be built', () => {
    expectDoesNotFire(sectionMissing, artifactFixture({ readError: 'empty' }))
  })

  it('does not consider a heading inside a fenced block', () => {
    expectFires(sectionMissing, body('# Skill\n\n```md\n## Done When\n```\n'))
  })
})
