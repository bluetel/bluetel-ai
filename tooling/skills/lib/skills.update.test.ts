import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeCatalog, makeTarget, parseActions, runSkills, writeSkill } from './test-helpers'

const read = (target: string, name: string): string =>
  readFileSync(join(target, '.agents/skills', name, 'SKILL.md'), 'utf8')

describe('skills.sh update', () => {
  it('overwrites outdated selected skills and leaves unselected ones untouched (FR-010)', () => {
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge.' },
      { name: 'review', version: '1.0.0', description: 'Review.' },
    ])
    const target = makeTarget()
    runSkills(['install', 'merging', 'review'], { catalog, target })
    const reviewBefore = read(target, 'review')

    writeSkill(catalog, {
      name: 'merging',
      version: '2.0.0',
      description: 'Merge.',
      files: { 'SKILL.md': '# merging v2\n' },
    })
    writeSkill(catalog, {
      name: 'review',
      version: '2.0.0',
      description: 'Review.',
      files: { 'SKILL.md': '# review v2\n' },
    })

    const res = runSkills(['update', 'merging'], { catalog, target })

    expect(res.status).toBe(0)
    expect(parseActions(res.stdout).find((a) => a.name === 'merging')?.action).toBe('update')
    expect(read(target, 'merging')).toBe('# merging v2\n')
    expect(read(target, 'review')).toBe(reviewBefore) // untouched
  })

  it('--all targets every installed outdated skill', () => {
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge.' },
      { name: 'review', version: '1.0.0', description: 'Review.' },
    ])
    const target = makeTarget()
    runSkills(['install', 'merging', 'review'], { catalog, target })

    writeSkill(catalog, { name: 'merging', version: '2.0.0', description: 'Merge.' })
    writeSkill(catalog, { name: 'review', version: '3.0.0', description: 'Review.' })

    const res = runSkills(['update', '--all'], { catalog, target })
    expect(res.status).toBe(0)
    const actions = parseActions(res.stdout)
    expect(actions.find((a) => a.name === 'merging')?.action).toBe('update')
    expect(actions.find((a) => a.name === 'review')?.action).toBe('update')
  })

  it('refuses a locally-modified skill without a mode → conflict, unchanged, exit 3 (FR-012)', () => {
    const catalog = makeCatalog([{ name: 'merging', version: '1.0.0', description: 'Merge.' }])
    const target = makeTarget()
    runSkills(['install', 'merging'], { catalog, target })

    const edited = '# merging\n\nLOCAL EDIT\n'
    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), edited)

    const res = runSkills(['update', 'merging'], { catalog, target })

    expect(res.status).toBe(3)
    expect(parseActions(res.stdout).find((a) => a.name === 'merging')?.action).toBe('conflict')
    expect(read(target, 'merging')).toBe(edited) // byte-for-byte unchanged
  })

  it('--on-conflict keep leaves the file byte-for-byte unchanged, exit 0', () => {
    const catalog = makeCatalog([{ name: 'merging', version: '1.0.0', description: 'Merge.' }])
    const target = makeTarget()
    runSkills(['install', 'merging'], { catalog, target })

    const edited = '# merging\n\nLOCAL EDIT\n'
    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), edited)

    const res = runSkills(['update', 'merging', '--on-conflict', 'keep'], { catalog, target })

    expect(res.status).toBe(0)
    expect(parseActions(res.stdout).find((a) => a.name === 'merging')?.action).toBe('keep')
    expect(read(target, 'merging')).toBe(edited)
  })

  it('--on-conflict overwrite (and --force) writes the incoming version, exit 0 (FR-012a)', () => {
    const target = makeTarget()
    const catalog = makeCatalog([
      { name: 'merging', version: '1.0.0', description: 'Merge.', files: { 'SKILL.md': 'v1\n' } },
    ])
    runSkills(['install', 'merging'], { catalog, target })

    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), 'LOCAL\n')
    writeSkill(catalog, {
      name: 'merging',
      version: '2.0.0',
      description: 'Merge.',
      files: { 'SKILL.md': 'v2-incoming\n' },
    })

    const overwrite = runSkills(['update', 'merging', '--on-conflict', 'overwrite'], {
      catalog,
      target,
    })
    expect(overwrite.status).toBe(0)
    expect(parseActions(overwrite.stdout).find((a) => a.name === 'merging')?.action).toBe('update')
    expect(read(target, 'merging')).toBe('v2-incoming\n')

    // --force is the non-interactive alias for overwrite.
    writeFileSync(join(target, '.agents/skills/merging/SKILL.md'), 'LOCAL2\n')
    const forced = runSkills(['update', 'merging', '--force'], { catalog, target })
    expect(forced.status).toBe(0)
    expect(parseActions(forced.stdout).find((a) => a.name === 'merging')?.action).toBe('update')
    expect(read(target, 'merging')).toBe('v2-incoming\n')
  })
})
