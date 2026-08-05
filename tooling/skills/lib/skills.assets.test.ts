import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  makeCatalog,
  makeTarget,
  parseActions,
  runSkills,
  writeAssetBundle,
  writeSkill,
  type FixtureSkill,
} from './test-helpers'

const BUNDLE = {
  '.specify/templates/plan-template.md': '# Plan template\n',
  '.specify/scripts/bash/setup-plan.sh': '#!/usr/bin/env bash\necho plan\n',
}

const SKILLS: FixtureSkill[] = [
  { name: 'speckit-plan', version: '1.0.1', description: 'Plan a feature.', assets: ['speckit'] },
  { name: 'speckit-tasks', version: '1.0.1', description: 'Generate tasks.', assets: ['speckit'] },
  { name: 'merging', version: '1.2.0', description: 'Merge a feature branch.' },
]

/** A catalog whose speckit skills declare the `speckit` bundle. */
const makeCatalogWithBundle = (): string => {
  const catalog = makeCatalog(SKILLS)
  writeAssetBundle(catalog, 'speckit', BUNDLE)
  return catalog
}

const bundlePaths = (target: string): string[] => Object.keys(BUNDLE).map((r) => join(target, r))

describe('skills.sh asset bundles', () => {
  it('seeds a declared bundle into the target root on install', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()

    const res = runSkills(['install', 'speckit-plan'], { catalog, target })

    expect(res.status).toBe(0)
    for (const path of bundlePaths(target)) expect(existsSync(path)).toBe(true)
    expect(readFileSync(join(target, '.specify/templates/plan-template.md'), 'utf8')).toBe(
      BUNDLE['.specify/templates/plan-template.md'],
    )
  })

  it('records the bundle on the installed skill', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()

    runSkills(['install', 'speckit-plan'], { catalog, target })

    const record = readFileSync(join(target, '.agents/skills/speckit-plan/.skill'), 'utf8')
    expect(record).toMatch(/^assets=speckit$/m)
  })

  it('seeds a shared bundle once across skills that declare it', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()

    const res = runSkills(['install', 'speckit-plan', 'speckit-tasks'], { catalog, target })

    expect(res.status).toBe(0)
    const seeded = res.stdout
      .split('\n')
      .filter((l) => l.includes('.specify/templates/plan-template.md'))
    expect(seeded).toHaveLength(1)
  })

  it('leaves the target untouched outside .agents/.claude for skills without assets (SC-002)', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()

    runSkills(['install', 'merging'], { catalog, target })

    expect(readdirSync(target).sort()).toEqual(['.agents', '.claude'])
  })

  it('re-seeds bundle files deleted from the target, even when the skill is up-to-date', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()
    runSkills(['install', 'speckit-plan'], { catalog, target })
    rmSync(join(target, '.specify/templates/plan-template.md'))

    const res = runSkills(['install', 'speckit-plan'], { catalog, target })

    expect(res.status).toBe(0)
    expect(parseActions(res.stdout)[0]?.action).toBe('skip')
    expect(existsSync(join(target, '.specify/templates/plan-template.md'))).toBe(true)
  })

  it('keeps a locally-edited bundle file and reports it', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()
    runSkills(['install', 'speckit-plan'], { catalog, target })
    const local = join(target, '.specify/templates/plan-template.md')
    writeFileSync(local, '# Tailored for this project\n')

    const res = runSkills(['install', 'speckit-plan'], { catalog, target })

    expect(res.status).toBe(0)
    expect(readFileSync(local, 'utf8')).toBe('# Tailored for this project\n')
    expect(res.stdout).toContain('.specify/templates/plan-template.md (kept')
  })

  it('does not treat an edited bundle file as a locally-modified skill', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()
    runSkills(['install', 'speckit-plan'], { catalog, target })
    writeFileSync(join(target, '.specify/templates/plan-template.md'), '# Tailored\n')

    const res = runSkills(['status'], { catalog, target })

    expect(res.stdout).toContain('speckit-plan\tup-to-date')
  })

  it('overwrites an edited bundle file under --force', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()
    runSkills(['install', 'speckit-plan'], { catalog, target })
    const local = join(target, '.specify/templates/plan-template.md')
    writeFileSync(local, '# Tailored\n')

    const res = runSkills(['install', 'speckit-plan', '--force'], { catalog, target })

    expect(res.status).toBe(0)
    expect(readFileSync(local, 'utf8')).toBe(BUNDLE['.specify/templates/plan-template.md'])
  })

  it('seeds the bundle when an older install is updated (heals a pre-assets target)', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()
    writeSkill(catalog, { name: 'speckit-plan', version: '1.0.0', description: 'Plan a feature.' })
    runSkills(['install', 'speckit-plan'], { catalog, target })
    expect(existsSync(join(target, '.specify'))).toBe(false)

    writeSkill(catalog, {
      name: 'speckit-plan',
      version: '1.0.1',
      description: 'Plan a feature.',
      assets: ['speckit'],
    })
    const res = runSkills(['update', 'speckit-plan'], { catalog, target })

    expect(res.status).toBe(0)
    expect(parseActions(res.stdout)[0]?.action).toBe('update')
    for (const path of bundlePaths(target)) expect(existsSync(path)).toBe(true)
  })

  it('removes bundle files it created when the install is rolled back', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()

    const res = runSkills(['install', 'speckit-plan'], {
      catalog,
      target,
      env: { SKILLS_FAIL_AFTER: 'speckit-plan' },
    })

    expect(res.status).toBe(4)
    expect(existsSync(join(target, '.specify'))).toBe(false)
  })

  it('preserves a pre-existing bundle file through a rollback', () => {
    const catalog = makeCatalogWithBundle()
    const target = makeTarget()
    const kept = join(target, '.specify/templates/plan-template.md')
    mkdirSync(dirname(kept), { recursive: true })
    writeFileSync(kept, '# Tailored\n')

    const res = runSkills(['install', 'speckit-plan'], {
      catalog,
      target,
      env: { SKILLS_FAIL_AFTER: 'speckit-plan' },
    })

    expect(res.status).toBe(4)
    expect(readFileSync(kept, 'utf8')).toBe('# Tailored\n')
  })

  it('rejects a catalog whose declared bundle is missing (exit 2)', () => {
    const catalog = makeCatalog(SKILLS) // no bundle written
    const target = makeTarget()

    const res = runSkills(['install', 'speckit-plan'], { catalog, target })

    expect(res.status).toBe(2)
    expect(res.stderr).toContain("missing asset bundle 'speckit'")
    expect(existsSync(join(target, '.agents/skills/speckit-plan'))).toBe(false)
  })
})
