import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, parseList, runSkills } from './test-helpers'

describe('skills.sh list — descriptions (US3 / FR-015)', () => {
  it('includes a non-empty DESCRIPTION for every catalog skill, sourced from skill.meta', () => {
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge a feature branch into staging.' },
      { name: 'review', version: '1.0.0', description: 'Structured code review.' },
    ])
    const target = makeTarget()

    const rows = parseList(runSkills(['list'], { catalog, target }).stdout)

    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.description.length).toBeGreaterThan(0)
    expect(rows.find((r) => r.name === 'merging')?.description).toBe(
      'Merge a feature branch into staging.',
    )
  })

  it('treats a catalog entry missing description as a catalog error (exit 2)', () => {
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge a branch.' },
    ])
    const target = makeTarget()

    // Overwrite skill.meta with a description-less body — the list must not drift from content.
    writeFileSync(
      join(catalog, 'merging', 'skill.meta'),
      'name=merging\nversion=1.0.0\nrequires=\n',
    )

    const res = runSkills(['list'], { catalog, target })

    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/description/i)
  })
})
