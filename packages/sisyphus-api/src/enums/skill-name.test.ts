import { describe, expect, it } from 'vitest'

import { isSkillName, SKILL_NAMES } from './skill-name'

describe('SKILL_NAMES', () => {
  it('carries the three skills a run may resolve (FR-059)', () => {
    expect([...SKILL_NAMES]).toStrictEqual([
      'sisyphus-dev',
      'sisyphus-review',
      'sisyphus-integration',
    ])
  })

  it('names skills the way the directories on disk are named, not in snake_case', () => {
    for (const name of SKILL_NAMES) {
      expect(name).toMatch(/^sisyphus-[a-z]+$/)
    }
  })

  it('guards membership', () => {
    expect(isSkillName('sisyphus-review')).toBe(true)
    expect(isSkillName('sisyphus_review')).toBe(false)
  })
})
