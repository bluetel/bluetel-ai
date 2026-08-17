import { describe, expect, it } from 'vitest'

import {
  artifactFixture,
  expectDoesNotFire,
  expectFires,
  metaFixture,
  pointerFixture,
} from '../test-helpers'

import { duplicateKey, requiredField, strayLine, versionSemver } from './metadata'

describe('meta/required-field', () => {
  it('fires on a skill.meta with an empty description, naming the field', () => {
    const [finding] = expectFires(requiredField, metaFixture({ description: '' }))
    expect(finding.message).toContain('`description`')
    expect(finding.remediation).toContain('Use when:')
  })

  it('fires on a missing name, at the block’s first line', () => {
    const artifact = artifactFixture({
      path: 'tooling/skills/catalog/x/skill.meta',
      kind: 'catalog-meta',
      content: 'version=1.0.0\ndescription=d\n',
    })
    expect(expectFires(requiredField, artifact)[0].line).toBe(1)
  })

  it('fires once per missing field', () => {
    const artifact = artifactFixture({
      path: 'tooling/skills/catalog/x/skill.meta',
      kind: 'catalog-meta',
      content: 'name=x\n',
    })
    expect(expectFires(requiredField, artifact)).toHaveLength(2)
  })

  it('does not fire on a complete skill.meta', () => {
    expectDoesNotFire(requiredField, metaFixture())
  })

  it('requires only name and description of a pointer — a pointer has no version', () => {
    expectDoesNotFire(requiredField, pointerFixture())
    expectFires(requiredField, pointerFixture({ description: '' }))
  })
})

describe('meta/duplicate-key', () => {
  it('fires on a repeated version, naming every line', () => {
    const artifact = artifactFixture({
      path: 'tooling/skills/catalog/x/skill.meta',
      kind: 'catalog-meta',
      content: 'name=x\nversion=1.0.0\ndescription=d\nversion=2.0.0\n',
    })
    const [finding] = expectFires(duplicateKey, artifact)
    expect(finding.message).toContain('`version` appears 2 times (lines 2, 4)')
    expect(finding.message).toContain('Only the first is read')
  })

  it('does not fire on a repeated next_step — the one repeatable key', () => {
    expectDoesNotFire(duplicateKey, metaFixture({ nextSteps: ['/a|why a', '/b|why b'] }))
  })

  it('does not fire on a well-formed block', () => {
    expectDoesNotFire(duplicateKey, metaFixture())
  })
})

describe('meta/version-semver', () => {
  it.each(['1.0', 'v1.0.0', '1.0.0-beta', 'latest', '01.0.0'])(
    'fires on version `%s`',
    (version) => {
      const [finding] = expectFires(versionSemver, metaFixture({ version }))
      expect(finding.message).toContain(version)
    },
  )

  it.each(['0.0.0', '1.0.0', '10.20.30'])('does not fire on version `%s`', (version) => {
    expectDoesNotFire(versionSemver, metaFixture({ version }))
  })

  it('stays silent on an absent version — that is required-field’s finding, not this one', () => {
    // Two rules reporting one missing field is how a report starts getting skimmed.
    expectDoesNotFire(versionSemver, metaFixture({ version: '' }))
  })

  it('does not apply to a pointer, which has no version', () => {
    expect(versionSemver.appliesTo).toEqual(['catalog-meta'])
  })
})

describe('meta/stray-line', () => {
  it('fires on a wrapped description line, which looks set and is not', () => {
    const [finding] = expectFires(
      strayLine,
      metaFixture({ extraLines: ['and this continues the description'] }),
    )
    expect(finding.message).toContain('neither a comment nor')
    expect(finding.remediation).toContain('one line')
  })

  it('does not fire on comments or blank lines', () => {
    expectDoesNotFire(strayLine, metaFixture({ extraLines: ['# a note', ''] }))
  })

  it('does not fire on a well-formed block', () => {
    expectDoesNotFire(strayLine, metaFixture())
  })
})
