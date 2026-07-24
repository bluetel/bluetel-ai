import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, parseList, runSkills } from './test-helpers'

const CATALOG = [
  { name: 'merging', version: '1.2.0', description: 'Merge a feature branch into staging.' },
  { name: 'pr-creation', version: '2.0.1', description: 'Create a pull request.' },
  { name: 'review', version: '0.4.0', description: 'Structured code review.' },
]

describe('skills.sh list', () => {
  it('reports every catalog skill as not-installed on a clean target (SC-006)', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['list'], { catalog, target })

    expect(res.status).toBe(0)
    const rows = parseList(res.stdout)
    expect(rows).toHaveLength(CATALOG.length)
    for (const row of rows) expect(row.state).toBe('not-installed')
  })

  it('emits NAME/STATE/CATALOG_VERSION/INSTALLED_VERSION/DESCRIPTION with description from skill.meta', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const rows = parseList(runSkills(['list'], { catalog, target }).stdout)

    const merging = rows.find((r) => r.name === 'merging')
    expect(merging).toBeDefined()
    expect(merging?.catalogVersion).toBe('1.2.0')
    expect(merging?.installedVersion).toBe('')
    expect(merging?.description).toBe('Merge a feature branch into staging.')
  })
})
