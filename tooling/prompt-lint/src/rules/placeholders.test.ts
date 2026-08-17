import { describe, expect, it } from 'vitest'

import { artifactFixture, expectDoesNotFire, expectFires } from '../test-helpers'

import { placeholderResidue } from './placeholders'

const guidance = (content: string) =>
  artifactFixture({ path: 'AGENTS.md', kind: 'guidance', content })

const template = (content: string) =>
  artifactFixture({
    path: '.specify/templates/plan-template.md',
    kind: 'speckit-template',
    content,
  })

describe('template/placeholder-residue', () => {
  it.each([
    ['a bracketed SCREAMING_SNAKE slot', '# [PROJECT_NAME] rules\n'],
    ['a bracketed Title Case slot', '# [Project Name] rules\n'],
    ['a clarification marker', 'The limit is NEEDS_CLARIFICATION.\n'],
    ['an unresolved TODO', 'TODO: decide the threshold.\n'],
    ['the argument slot', 'Run with $ARGUMENTS.\n'],
  ])('fires on %s', (_label, content) => {
    const [finding] = expectFires(placeholderResidue, guidance(content))
    expect(finding.remediation).toContain('backticks')
  })

  describe('the one slot where `$ARGUMENTS` is meaningful', () => {
    // The contract says "$ARGUMENTS outside the one slot where it is meaningful", and the
    // qualifier was missing. In a `speckit-*` body the token is the substitution slot the
    // harness fills at invocation, so reporting it asked six skills to delete the mechanism
    // by which they receive their arguments. Measured during T058.
    const skill = (content: string) =>
      artifactFixture({
        path: 'tooling/skills/catalog/speckit-plan/SKILL.md',
        kind: 'catalog-skill',
        content,
      })

    it.each([
      ['alone on its line', '## Context\n\n$ARGUMENTS\n'],
      ['after a label', 'Context for task generation: $ARGUMENTS\n'],
      ['with trailing whitespace', '$ARGUMENTS  \n'],
    ])('does not fire when it is the slot, %s', (_label, content) => {
      expectDoesNotFire(placeholderResidue, skill(content))
    })

    it.each([
      ['mid-sentence', 'Parse $ARGUMENTS for optional tokens before dispatching.\n'],
      ['followed by prose', '$ARGUMENTS is the feature description you were given.\n'],
    ])('still fires when it is used as prose, %s', (_label, content) => {
      // Not the slot: here the token really is ambiguous with content, which is the
      // condition the rule exists for. Every such use in this repository sits in backticks,
      // and a code span was already exempt.
      expectFires(placeholderResidue, skill(content))
    })
  })

  // This exemption is load-bearing rather than a nicety: it is what lets the constitution's
  // SYNC IMPACT REPORT comment quote the tokens, and what lets the rule catalogue quote
  // every token it matches.
  describe('does not fire on a token', () => {
    it('inside a code span', () => {
      expectDoesNotFire(placeholderResidue, guidance('Replace `[PROJECT_NAME]` with the name.\n'))
    })

    it('inside a fenced block', () => {
      expectDoesNotFire(placeholderResidue, guidance('```md\n# [PROJECT_NAME]\n```\n'))
    })

    it('inside an HTML comment', () => {
      expectDoesNotFire(placeholderResidue, guidance('<!-- [PROJECT_NAME] is a slot -->\n'))
    })

    it('inside a multi-line HTML comment, which is the constitution’s shape', () => {
      expectDoesNotFire(placeholderResidue, guidance('<!--\nSYNC: [PROJECT_NAME]\n-->\n'))
    })
  })

  it('does not fire on a markdown checkbox', () => {
    expectDoesNotFire(placeholderResidue, guidance('- [ ] a task\n- [x] a done task\n'))
  })

  it('does not fire on prose with no tokens', () => {
    expectDoesNotFire(placeholderResidue, guidance('# Rules\n\nBe careful.\n'))
  })

  it('reports each token on a line separately, in column order', () => {
    const findings = expectFires(placeholderResidue, guidance('[FIRST_SLOT] then [SECOND_SLOT]\n'))
    expect(findings).toHaveLength(2)
    expect(findings[0].column).toBeLessThan(findings[1].column ?? 0)
  })

  describe('inverted for a Spec Kit template', () => {
    it('does not fire when the template still carries its slots', () => {
      expectDoesNotFire(placeholderResidue, template('# [FEATURE_NAME]\n\n[DESCRIPTION]\n'))
    })

    it('fires when a template has been filled in place', () => {
      // A filled-in template produces one repository's document for every future feature.
      const [finding] = expectFires(
        placeholderResidue,
        template('# Prompt validator\n\nA real filled-in plan.\n'),
      )
      expect(finding.message).toContain('filled in place')
    })
  })
})
