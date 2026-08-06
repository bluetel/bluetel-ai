import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  haltForSkill,
  parseSkillDocument,
  primarySkillSource,
  resolveSkill,
  resolveSkills,
  skillCandidatePaths,
  skillDigest,
  SKILL_NAMES,
  SkillResolutionError,
  type SkillReferenceReport,
  type SkillSource,
} from './resolve'

const scratchDirectories: string[] = []

const scratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'sisyphus-skills-'))

  scratchDirectories.push(directory)

  return directory
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const writeSkill = async (root: string, relativePath: string, body: string): Promise<void> => {
  const path = join(root, relativePath)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

const devSkill = (name = 'sisyphus-dev'): string =>
  `---\nname: ${name}\ndescription: how this repository develops\n---\n\nBranch as \`feat/<ticket>\`.\n`

interface Recorder {
  readonly reports: SkillReferenceReport[]
  readonly report: (report: SkillReferenceReport) => void
}

const recorder = (): Recorder => {
  const reports: SkillReferenceReport[] = []

  return {
    reports,
    report: (report) => {
      reports.push(report)
    },
  }
}

const source = (path: string): SkillSource => ({ entryId: 'entry-1', path })

describe('skill locations', () => {
  it('looks in the two conventional locations, in order', () => {
    expect(skillCandidatePaths('sisyphus-dev')).toEqual([
      '.claude/skills/sisyphus-dev/SKILL.md',
      '.agents/skills/sisyphus-dev/SKILL.md',
    ])
  })

  it('covers every skill the platform knows about', () => {
    expect([...SKILL_NAMES]).toEqual(['sisyphus-dev', 'sisyphus-review', 'sisyphus-integration'])
  })
})

describe('parseSkillDocument', () => {
  it('separates front matter from the body and reads the declared name', () => {
    expect(parseSkillDocument(devSkill())).toEqual({
      declaredName: 'sisyphus-dev',
      body: 'Branch as `feat/<ticket>`.',
    })
  })

  it('strips quotes around a declared name', () => {
    expect(parseSkillDocument("---\nname: 'sisyphus-dev'\n---\nbody\n").declaredName).toBe(
      'sisyphus-dev',
    )
  })

  it('treats a file with no front matter as all body', () => {
    expect(parseSkillDocument('just prose\n')).toEqual({ body: 'just prose' })
  })

  it('treats an unterminated fence as all body rather than throwing', () => {
    expect(parseSkillDocument('---\nname: x\nstill going').body).toContain('still going')
  })
})

describe('resolveSkill — the happy path', () => {
  it('resolves from the primary entry and reports the content digest (FR-059)', async () => {
    const root = await scratch()
    const body = devSkill()

    await writeSkill(root, '.claude/skills/sisyphus-dev/SKILL.md', body)

    const log = recorder()
    const resolved = await resolveSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: log.report,
    })

    expect(resolved.resolvedPath).toBe('.claude/skills/sisyphus-dev/SKILL.md')
    expect(resolved.contentDigest).toBe(skillDigest(new TextEncoder().encode(body)))
    expect(resolved.body).toContain('feat/<ticket>')
    expect(log.reports).toEqual([
      {
        skillName: 'sisyphus-dev',
        entryId: 'entry-1',
        resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
        contentDigest: resolved.contentDigest,
        phase: 'develop',
      },
    ])
  })

  it('gives two different revisions of the same skill two different digests', async () => {
    const first = await scratch()
    const second = await scratch()

    await writeSkill(first, '.claude/skills/sisyphus-dev/SKILL.md', devSkill())
    await writeSkill(
      second,
      '.claude/skills/sisyphus-dev/SKILL.md',
      `${devSkill()}\nAlso rebase before opening.\n`,
    )

    const log = recorder()
    const options = { step: 'develop', report: log.report }
    const a = await resolveSkill('sisyphus-dev', { ...options, source: source(first) })
    const b = await resolveSkill('sisyphus-dev', { ...options, source: source(second) })

    // The digest is the only version a repository file has; if it did not move
    // when the content did, a past run could not be explained (SC-016).
    expect(a.contentDigest).not.toBe(b.contentDigest)
  })

  it('falls back to the shared location when the agent one is absent', async () => {
    const root = await scratch()

    await writeSkill(root, '.agents/skills/sisyphus-review/SKILL.md', devSkill('sisyphus-review'))

    const resolved = await resolveSkill('sisyphus-review', {
      source: source(root),
      step: 'review',
      report: recorder().report,
    })

    expect(resolved.resolvedPath).toBe('.agents/skills/sisyphus-review/SKILL.md')
  })

  it('takes the first location rather than treating a pointer file as a conflict', async () => {
    const root = await scratch()

    await writeSkill(
      root,
      '.claude/skills/sisyphus-dev/SKILL.md',
      '---\nname: sisyphus-dev\n---\nSee `.agents/skills/sisyphus-dev/SKILL.md`.\n',
    )
    await writeSkill(root, '.agents/skills/sisyphus-dev/SKILL.md', devSkill())

    const resolved = await resolveSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: recorder().report,
    })

    expect(resolved.resolvedPath).toBe('.claude/skills/sisyphus-dev/SKILL.md')
  })

  it('resolves several skills and reports each one', async () => {
    const root = await scratch()

    for (const skillName of SKILL_NAMES) {
      await writeSkill(root, `.claude/skills/${skillName}/SKILL.md`, devSkill(skillName))
    }

    const log = recorder()
    const resolved = await resolveSkills([...SKILL_NAMES], {
      source: source(root),
      step: 'develop',
      report: log.report,
    })

    expect([...resolved.keys()]).toEqual([...SKILL_NAMES])
    expect(log.reports).toHaveLength(SKILL_NAMES.length)
    expect(log.reports.every((report) => report.contentDigest !== undefined)).toBe(true)
  })

  it('reads skills from the primary entry only (FR-110)', async () => {
    const root = await scratch()

    await writeSkill(root, 'primary/.claude/skills/sisyphus-dev/SKILL.md', devSkill())
    await writeSkill(root, 'secondary/.claude/skills/sisyphus-dev/SKILL.md', devSkill())

    const workspace = {
      root,
      configDir: join(root, '.agent-config'),
      entries: [],
      primary: {
        entryId: 'primary-entry',
        subdirectory: 'primary',
        path: join(root, 'primary'),
        baseBranch: 'main',
        resolvedCommit: 'abc',
        isPrimary: true,
      },
    }

    // `primarySkillSource` reads `primary` and never `entries`, which is what
    // makes "primary only" a property of the code path.
    const derived = primarySkillSource(
      workspace as unknown as Parameters<typeof primarySkillSource>[0],
    )

    expect(derived).toEqual({ entryId: 'primary-entry', path: join(root, 'primary') })

    const resolved = await resolveSkill('sisyphus-dev', {
      source: derived,
      step: 'develop',
      report: recorder().report,
    })

    expect(resolved.absolutePath.startsWith(join(root, 'primary'))).toBe(true)
  })
})

describe('resolveSkill — halting (FR-058)', () => {
  it('halts naming the skill and the step when the file is absent', async () => {
    const root = await scratch()
    const log = recorder()
    const failure = await resolveSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: log.report,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SkillResolutionError)
    expect(failure).toMatchObject({ skillName: 'sisyphus-dev', step: 'develop', kind: 'missing' })
    expect((failure as SkillResolutionError).message).toContain('sisyphus-dev')
    expect((failure as SkillResolutionError).message).toContain('develop')
  })

  it('takes no guessed action: the halt carries no convention of any kind', async () => {
    const root = await scratch()
    const failure = (await resolveSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: recorder().report,
    }).catch((error: unknown) => error)) as SkillResolutionError

    expect(failure.message).toContain('No branch, ticket or delivery action is taken on a guess')
    // Everything on the error describes the failure. Nothing on it is usable as
    // a branch name, a target branch or a ticket transition.
    expect(Object.keys(failure)).toEqual(
      expect.arrayContaining(['skillName', 'step', 'kind', 'reason', 'entryId', 'searched']),
    )
    expect(failure.searched).toEqual(skillCandidatePaths('sisyphus-dev'))
  })

  it('records the attempt before halting, so the run stays explicable', async () => {
    const root = await scratch()
    const log = recorder()

    await resolveSkill('sisyphus-integration', {
      source: source(root),
      step: 'integrate',
      report: log.report,
    }).catch(() => undefined)

    expect(log.reports).toHaveLength(1)
    expect(log.reports[0]).toMatchObject({
      skillName: 'sisyphus-integration',
      entryId: 'entry-1',
      phase: 'integrate',
    })
    expect(log.reports[0]?.unavailableReason).toContain('missing')
  })

  it('halts when the file exists but cannot be read', async () => {
    const root = await scratch()

    await writeSkill(root, '.claude/skills/sisyphus-dev/SKILL.md', devSkill())
    await chmod(join(root, '.claude/skills/sisyphus-dev/SKILL.md'), 0o000)

    const failure = await resolveSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: recorder().report,
    }).catch((error: unknown) => error)

    // Running as root defeats the mode, in which case the read succeeds; the
    // assertion is that either way nothing is guessed.
    if (failure instanceof SkillResolutionError) {
      expect(failure.kind).toBe('unreadable')
    } else {
      expect(failure).toMatchObject({ skillName: 'sisyphus-dev' })
    }
  })

  it('halts when the skill has no content below its front matter', async () => {
    const root = await scratch()

    await writeSkill(root, '.claude/skills/sisyphus-dev/SKILL.md', '---\nname: sisyphus-dev\n---\n')

    await expect(
      resolveSkill('sisyphus-dev', {
        source: source(root),
        step: 'develop',
        report: recorder().report,
      }),
    ).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('halts when the file declares itself to be a different skill', async () => {
    const root = await scratch()

    await writeSkill(root, '.claude/skills/sisyphus-dev/SKILL.md', devSkill('sisyphus-integration'))

    const failure = await resolveSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: recorder().report,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'contradictory', skillName: 'sisyphus-dev' })
    expect((failure as SkillResolutionError).message).toContain('sisyphus-integration')
  })

  it('stops at the first unusable skill rather than reporting a run that did not happen', async () => {
    const root = await scratch()

    await writeSkill(root, '.claude/skills/sisyphus-dev/SKILL.md', devSkill())

    const log = recorder()

    await expect(
      resolveSkills([...SKILL_NAMES], {
        source: source(root),
        step: 'develop',
        report: log.report,
      }),
    ).rejects.toMatchObject({ skillName: 'sisyphus-review' })

    expect(log.reports.map((report) => report.skillName)).toEqual([
      'sisyphus-dev',
      'sisyphus-review',
    ])
  })
})

describe('haltForSkill', () => {
  it('gives a step that finds a contradiction while reading the same halt path', async () => {
    const root = await scratch()
    const log = recorder()
    const failure = await haltForSkill('sisyphus-dev', {
      source: source(root),
      step: 'develop',
      report: log.report,
      resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
      reason: 'it names two different branch prefixes and does not say which wins',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SkillResolutionError)
    expect(failure).toMatchObject({ kind: 'contradictory', step: 'develop' })
    expect(log.reports[0]?.unavailableReason).toContain('two different branch prefixes')
  })
})
