import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, parseList, runSkills, writeSkill } from './test-helpers'

describe('skills.sh status', () => {
  it('lists only skills present in the target', () => {
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge.' },
      { name: 'review', version: '1.0.0', description: 'Review.' },
    ])
    const target = makeTarget()
    runSkills(['install', 'merging'], { catalog, target })

    const rows = parseList(runSkills(['status'], { catalog, target }).stdout)

    expect(rows.map((r) => r.name)).toEqual(['merging'])
  })

  it('flips an installed skill to outdated when the catalog version is bumped (FR-011)', () => {
    const catalog = makeCatalog([{ name: 'merging', version: '1.0.0', description: 'Merge.' }])
    const target = makeTarget()
    runSkills(['install', 'merging'], { catalog, target })

    // Bump the catalog version.
    writeSkill(catalog, { name: 'merging', version: '1.1.0', description: 'Merge.' })

    const rows = parseList(runSkills(['status'], { catalog, target }).stdout)
    const merging = rows.find((r) => r.name === 'merging')
    expect(merging?.state).toBe('outdated')
    expect(merging?.catalogVersion).toBe('1.1.0')
    expect(merging?.installedVersion).toBe('1.0.0')
  })
})
