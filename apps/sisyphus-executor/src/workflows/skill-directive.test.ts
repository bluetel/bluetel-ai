import { describe, expect, it } from 'vitest'

import type { ResolvedSkill } from '../skills'

import {
  directiveDigests,
  directiveFrom,
  requireDirective,
  undirectedActionError,
} from './skill-directive'

/**
 * The seam that makes "no convention is hardcoded" structural rather than careful (FR-057,
 * FR-058, FR-059).
 */

const resolved = (overrides: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  skillName: 'sisyphus-dev',
  entryId: 'entry-1',
  resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-dev/SKILL.md',
  contentDigest: 'a'.repeat(64),
  byteSize: 512,
  body: 'Name the branch after the ticket.',
  ...overrides,
})

describe('directiveFrom', () => {
  it('carries the digest of the file that was actually read (FR-059)', () => {
    const directive = directiveFrom(resolved(), {
      step: 'develop',
      instruction: 'Name the branch after the ticket.',
    })

    expect(directive.contentDigest).toBe('a'.repeat(64))
    expect(directive.resolvedPath).toBe('.claude/skills/sisyphus-dev/SKILL.md')
    expect(directive.skillName).toBe('sisyphus-dev')
    expect(directive.entryId).toBe('entry-1')
    expect(directive.step).toBe('develop')
  })
})

describe('requireDirective', () => {
  it('lets a prescribed action through', () => {
    const directive = directiveFrom(resolved(), { step: 'review', instruction: 'Move the ticket.' })

    expect(requireDirective(directive, 'move the ticket', 'review')).toBe(directive)
  })

  it('halts when nothing prescribed the action, naming the step', () => {
    expect(() => requireDirective(undefined, 'move the ticket', 'review')).toThrow(
      /the review step will not move the ticket/iu,
    )
  })

  it('halts on a directive that states nothing, rather than acting on the silence', () => {
    const empty = directiveFrom(resolved(), { step: 'review', instruction: '   ' })

    expect(() => requireDirective(empty, 'move the ticket', 'review')).toThrow()
  })

  it('offers no value a caller could mistake for a default', () => {
    const message = undirectedActionError('open a pull request', 'delivery').message

    expect(message).toContain('FR-057')
    expect(message).not.toMatch(/default|fallback|instead use/iu)
  })
})

describe('directiveDigests', () => {
  it('reduces to what makes a past run explicable after the skills change', () => {
    const dev = directiveFrom(resolved(), { step: 'develop', instruction: 'Branch per ticket.' })
    const review = directiveFrom(
      resolved({ skillName: 'sisyphus-review', contentDigest: 'b'.repeat(64) }),
      { step: 'review', instruction: 'Block on untested behaviour.' },
    )

    expect(directiveDigests([dev, review])).toEqual([
      { skillName: 'sisyphus-dev', contentDigest: 'a'.repeat(64) },
      { skillName: 'sisyphus-review', contentDigest: 'b'.repeat(64) },
    ])
  })
})
