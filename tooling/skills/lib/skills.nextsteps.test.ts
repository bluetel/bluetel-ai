import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  makeCatalog,
  makeTarget,
  parseActions,
  parseNextSteps,
  runSkills,
  type FixtureSkill,
} from './test-helpers'

const RATIFY =
  '/speckit-constitution|Principles gate every later phase.|constitution is a placeholder'
const AUTH = 'gh auth status|The PR is opened through gh.|gh reports no account'

const CATALOG: FixtureSkill[] = [
  { name: 'speckit-plan', version: '1.0.0', description: 'Plan.', nextSteps: [RATIFY] },
  { name: 'speckit-tasks', version: '1.0.0', description: 'Tasks.', nextSteps: [RATIFY] },
  { name: 'pr-creation', version: '1.0.0', description: 'Open a PR.', nextSteps: [AUTH] },
  { name: 'merging', version: '1.0.0', description: 'Merge a branch.' },
]

describe('skills.sh next-steps', () => {
  it('reports a skill’s recommendations as action/why/when', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()
    runSkills(['install', 'speckit-plan'], { catalog, target })

    const steps = parseNextSteps(runSkills(['next-steps'], { catalog, target }).stdout)

    expect(steps).toEqual([
      {
        name: 'speckit-plan',
        action: '/speckit-constitution',
        why: 'Principles gate every later phase.',
        when: 'constitution is a placeholder',
      },
    ])
  })

  it('dedupes an identical recommendation shared by several skills', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['install', 'speckit-plan', 'speckit-tasks'], { catalog, target })

    const ratify = parseNextSteps(res.stdout).filter((s) => s.action === '/speckit-constitution')
    expect(ratify).toHaveLength(1)
  })

  it('emits an empty when for a recommendation that always applies', () => {
    const catalog = makeCatalog([
      {
        name: 'merging',
        version: '1.0.0',
        description: 'Merge.',
        nextSteps: ['Commit it|Shared.'],
      },
    ])
    const target = makeTarget()
    runSkills(['install', 'merging'], { catalog, target })

    const steps = parseNextSteps(runSkills(['next-steps'], { catalog, target }).stdout)

    expect(steps).toEqual([{ name: 'merging', action: 'Commit it', why: 'Shared.', when: '' }])
  })

  it('reports every installed skill when given no names, and skips uninstalled ones', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()
    runSkills(['install', 'speckit-plan', 'pr-creation'], { catalog, target })

    const steps = parseNextSteps(runSkills(['next-steps'], { catalog, target }).stdout)

    expect(steps.map((s) => s.action).sort()).toEqual(['/speckit-constitution', 'gh auth status'])
  })

  it('narrows to the named skills', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()
    runSkills(['install', 'speckit-plan', 'pr-creation'], { catalog, target })

    const steps = parseNextSteps(
      runSkills(['next-steps', 'pr-creation'], { catalog, target }).stdout,
    )

    expect(steps.map((s) => s.action)).toEqual(['gh auth status'])
  })

  it('exits 0 with no output for a target with nothing installed', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['next-steps'], { catalog, target })

    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('')
  })

  it('prints recommendations after install as # comments, not action lines', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['install', 'speckit-plan'], { catalog, target })

    expect(res.stdout).toContain('# next: speckit-plan\t/speckit-constitution')
    // The advisory block must not leak into the machine-read action lines.
    expect(parseActions(res.stdout)).toEqual([
      { name: 'speckit-plan', action: 'install', version: '1.0.0' },
    ])
  })

  it('prints recommendations after update too', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()
    runSkills(['install', 'speckit-plan'], { catalog, target })

    const res = runSkills(['update', 'speckit-plan'], { catalog, target })

    expect(res.stdout).toContain('# next: speckit-plan\t/speckit-constitution')
  })

  it('says nothing for skills that declare no follow-up', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()

    const res = runSkills(['install', 'merging'], { catalog, target })

    expect(res.stdout).not.toContain('# next:')
  })

  it('treats a next_step without a reason as a catalog error (exit 2)', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()
    writeFileSync(
      join(catalog, 'merging', 'skill.meta'),
      'name=merging\nversion=1.0.0\ndescription=Merge.\nrequires=\nnext_step=/do-a-thing\n',
    )

    const res = runSkills(['install', 'merging'], { catalog, target })

    expect(res.status).toBe(2)
    expect(res.stderr).toContain('next_step must be')
  })

  it('treats a next_step with an empty action or reason as a catalog error (exit 2)', () => {
    const catalog = makeCatalog(CATALOG)
    const target = makeTarget()
    const base = 'name=merging\nversion=1.0.0\ndescription=Merge.\nrequires=\n'

    for (const bad of ['next_step=/do-a-thing|', 'next_step=|a reason', 'next_step=|']) {
      writeFileSync(join(catalog, 'merging', 'skill.meta'), `${base}${bad}\n`)
      const res = runSkills(['install', 'merging'], { catalog, target })
      expect(res.status, bad).toBe(2)
      expect(res.stderr, bad).toContain('non-empty action and why')
    }
  })
})
