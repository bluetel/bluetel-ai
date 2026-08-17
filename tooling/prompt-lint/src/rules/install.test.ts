import { describe, expect, it } from 'vitest'

import type { Artifact } from '../artifact'
import {
  artifactFixture,
  contextFixture,
  expectDoesNotFire,
  expectFires,
  metaFixture,
  pointerFixture,
  runRule,
  type ContextFixtureOptions,
} from '../test-helpers'

import type { DiffContext } from './define'
import {
  catalogDrift,
  installRules,
  notEvaluatedSetRules,
  pointerMismatch,
  versionBump,
} from './install'

const CATALOG = 'tooling/skills/catalog/example'
const INSTALLED = '.agents/skills/example'

const BODY = '# Example\n\n## Done When\n\n- [ ] it works\n'

/** A catalog-side file. `skill.meta` gets `catalog-meta`, everything else a markdown kind. */
const catalogFile = (relative: string, content = BODY): Artifact =>
  artifactFixture({
    path: `${CATALOG}/${relative}`,
    kind: relative === 'SKILL.md' ? 'catalog-skill' : 'catalog-reference',
    content,
    skillRoot: CATALOG,
  })

const installedFile = (relative: string, content = BODY): Artifact =>
  artifactFixture({
    path: `${INSTALLED}/${relative}`,
    kind: 'installed-skill',
    content,
    skillRoot: INSTALLED,
  })

/**
 * A base revision, addressed the way `DiffContext.at` addresses one: bytes for the paths
 * the map names, null for everything else. Null is how the rule learns a path is new.
 */
const diffFixture = (base: Map<string, string>, baseRef = 'origin/main'): DiffContext => ({
  baseRef,
  at: (path) => base.get(path) ?? null,
})

/**
 * The tracked-path list plus the universe for a paired skill. Both are supplied because
 * the rules read them for different questions — `index` for which files exist, `universe`
 * for what is in them — and a fixture that set only one would make the split untestable.
 */
const paired = (options: {
  catalogFiles?: readonly string[]
  installedFiles?: readonly string[]
  universe: readonly Artifact[]
}): ContextFixtureOptions => ({
  paths: [
    ...(options.catalogFiles ?? ['SKILL.md', 'skill.meta']).map(
      (relative) => `${CATALOG}/${relative}`,
    ),
    ...(options.installedFiles ?? ['SKILL.md', '.skill']).map(
      (relative) => `${INSTALLED}/${relative}`,
    ),
  ],
  universe: options.universe,
})

describe('install/catalog-drift', () => {
  it('fires on an installed copy whose bytes differ from the catalog entry', () => {
    const [finding] = expectFires(
      catalogDrift,
      null,
      paired({ universe: [catalogFile('SKILL.md'), installedFile('SKILL.md', '# Edited\n')] }),
    )

    expect(finding.path).toBe(`${INSTALLED}/SKILL.md`)
    expect(finding.related).toEqual([{ path: `${CATALOG}/SKILL.md` }])
    expect(finding.message).toContain('locally-modified')
  })

  it('does not fire when the two trees agree byte for byte', () => {
    expectDoesNotFire(
      catalogDrift,
      null,
      paired({ universe: [catalogFile('SKILL.md'), installedFile('SKILL.md')] }),
    )
  })

  it('does not fire on the files the installer deliberately leaves per-project', () => {
    // The live tree's steady state: `skill.meta` exists only in the catalog, `.skill` only
    // in the installed copy. Without the exclusion this is two findings per skill — the
    // case that decides whether the rule is usable at all. The `.skill` artifacts are not
    // declared artifacts and so never actually reach `universe`, but the exclusion must not
    // depend on that.
    expectDoesNotFire(
      catalogDrift,
      null,
      paired({
        catalogFiles: ['SKILL.md', 'skill.meta', '.skill'],
        installedFiles: ['SKILL.md', '.skill'],
        universe: [
          catalogFile('SKILL.md'),
          installedFile('SKILL.md'),
          installedFile('.skill', 'installed_hash=aaa\n'),
          catalogFile('.skill', 'installed_hash=bbb\n'),
        ],
      }),
    )
  })

  it('reports a file present in the catalog and absent from the installed copy', () => {
    const [finding] = expectFires(
      catalogDrift,
      null,
      paired({
        catalogFiles: ['SKILL.md', 'skill.meta', 'references/deep.md'],
        universe: [
          catalogFile('SKILL.md'),
          installedFile('SKILL.md'),
          catalogFile('references/deep.md'),
        ],
      }),
    )

    expect(finding.path).toBe(`${CATALOG}/references/deep.md`)
    expect(finding.related).toEqual([{ path: `${INSTALLED}/references/deep.md` }])
    expect(finding.message).toContain('missing from the installed copy')
  })

  it('reports a file present in the installed copy and in no catalog entry', () => {
    const [finding] = expectFires(
      catalogDrift,
      null,
      paired({
        installedFiles: ['SKILL.md', '.skill', 'references/stray.md'],
        universe: [
          catalogFile('SKILL.md'),
          installedFile('SKILL.md'),
          installedFile('references/stray.md'),
        ],
      }),
    )

    expect(finding.path).toBe(`${INSTALLED}/references/stray.md`)
    expect(finding.message).toContain('no catalog entry')
  })

  it('says nothing about a skill published in the catalog and installed nowhere', () => {
    // `frontend-design` today. A catalog publishes to many targets and each installs the
    // subset it wants, so a one-sided skill is not a pair and not a defect.
    expectDoesNotFire(catalogDrift, null, {
      paths: [`${CATALOG}/SKILL.md`, `${CATALOG}/skill.meta`],
      universe: [catalogFile('SKILL.md')],
    })
  })

  it('compares presence but not content for a file the declared set does not carry', () => {
    // `scripts/jira-sprint.sh` exists in both trees and in neither `universe`. The rule may
    // not claim two files match on bytes it never read, so this is silence here and an entry
    // from `notEvaluatedSetRules` when the cause is an unreadable artifact.
    expectDoesNotFire(
      catalogDrift,
      null,
      paired({
        catalogFiles: ['SKILL.md', 'skill.meta', 'scripts/run.sh'],
        installedFiles: ['SKILL.md', '.skill', 'scripts/run.sh'],
        universe: [catalogFile('SKILL.md'), installedFile('SKILL.md')],
      }),
    )
  })

  it('does not treat a tracked file under the installed root as a skill of its own', () => {
    // `.agents/skills/README.md` sits directly under the installed root, and reading its
    // first segment as a skill name invents a skill called `README.md`.
    expectDoesNotFire(catalogDrift, null, {
      paths: [`${CATALOG}/SKILL.md`, `${CATALOG}/skill.meta`, '.agents/skills/README.md'],
      universe: [catalogFile('SKILL.md')],
    })
  })
})

/** Base bytes for a paired skill whose content and version both match the working tree. */
const unchangedBase = (): Map<string, string> =>
  new Map([
    [`${CATALOG}/SKILL.md`, BODY],
    [`${CATALOG}/skill.meta`, metaFixture().content ?? ''],
  ])

const catalogUniverse = (options: { body?: string; version?: string } = {}): Artifact[] => [
  catalogFile('SKILL.md', options.body ?? BODY),
  metaFixture({ version: options.version ?? '1.0.0' }, `${CATALOG}/skill.meta`),
]

const versionContext = (
  base: Map<string, string>,
  universe: readonly Artifact[],
  deleted: readonly string[] = [],
): ContextFixtureOptions => ({
  paths: [`${CATALOG}/SKILL.md`, `${CATALOG}/skill.meta`],
  universe,
  diff: diffFixture(base),
  deleted,
})

describe('install/version-bump', () => {
  it('fires when the hashed content changed and the version did not', () => {
    const [finding] = expectFires(
      versionBump,
      null,
      versionContext(unchangedBase(), catalogUniverse({ body: '# Rewritten\n' })),
    )

    expect(finding.path).toBe(`${CATALOG}/skill.meta`)
    expect(finding.line).toBe(2)
    expect(finding.related).toEqual([{ path: `${CATALOG}/SKILL.md` }])
    expect(finding.message).toContain('`version` is still `1.0.0`')
  })

  it('does not fire when the content and the version both changed', () => {
    expectDoesNotFire(
      versionBump,
      null,
      versionContext(unchangedBase(), catalogUniverse({ body: '# Rewritten\n', version: '1.0.1' })),
    )
  })

  it('does not fire when nothing changed', () => {
    expectDoesNotFire(versionBump, null, versionContext(unchangedBase(), catalogUniverse()))
  })

  it('does not fire when only `skill.meta` changed, which the installer never hashes', () => {
    // A `description` edit changes no hashed byte, so no installed copy can go stale and
    // there is nothing for a version to signal.
    const base = unchangedBase()
    base.set(`${CATALOG}/skill.meta`, 'name=example\nversion=1.0.0\ndescription=Older wording.\n')
    expectDoesNotFire(versionBump, null, versionContext(base, catalogUniverse()))
  })

  it('fires on a content file added since the base ref', () => {
    const base = unchangedBase()
    const [finding] = expectFires(versionBump, null, {
      paths: [`${CATALOG}/SKILL.md`, `${CATALOG}/skill.meta`, `${CATALOG}/references/new.md`],
      universe: [...catalogUniverse(), catalogFile('references/new.md')],
      diff: diffFixture(base),
    })

    expect(finding.related).toEqual([{ path: `${CATALOG}/references/new.md` }])
  })

  it('fires on a content file deleted since the base ref', () => {
    // `DiffContext.at` cannot see a deletion — the path is gone from the index it would be
    // looked up in — so `context.deleted` is the only signal for this shape.
    expectFires(
      versionBump,
      null,
      versionContext(unchangedBase(), catalogUniverse(), [`${CATALOG}/references/gone.md`]),
    )
  })

  it('does not fire on a skill that did not exist at the base ref', () => {
    // A first published version is not a bump.
    expectDoesNotFire(versionBump, null, versionContext(new Map(), catalogUniverse()))
  })

  it('is reported not evaluated under `--all` rather than passing', () => {
    const context = {
      paths: [`${CATALOG}/SKILL.md`, `${CATALOG}/skill.meta`],
      universe: catalogUniverse(),
      diff: null,
    }

    // Both halves matter: the rule reports nothing, *and* the run says why. Either one alone
    // is a whole-surface scan silently claiming every version is bumped correctly.
    expect(runRule(versionBump, null, context)).toEqual([])
    const skips = notEvaluatedSetRules(contextFixture(context))
    expect(skips.map((skip) => skip.rule)).toContain('install/version-bump')
    expect(skips[0].reason).toContain('no base ref')
  })

  it('names no set-scoped rule not evaluated when a diff and every file are available', () => {
    expect(
      notEvaluatedSetRules(contextFixture(versionContext(unchangedBase(), catalogUniverse()))),
    ).toEqual([])
  })

  it('reports a comparison it could not make because a file was unreadable', () => {
    const skips = notEvaluatedSetRules(
      contextFixture({
        universe: [artifactFixture({ path: `${CATALOG}/SKILL.md`, readError: 'not-utf8' })],
        diff: diffFixture(new Map()),
      }),
    )

    expect(skips.map((skip) => skip.rule)).toEqual([
      'install/catalog-drift',
      'install/version-bump',
      'install/pointer-mismatch',
    ])
    expect(skips[0].reason).toContain(`${CATALOG}/SKILL.md`)
  })
})

/**
 * `pointerFixture` and `metaFixture` default to *different* descriptions, so both sides are
 * pinned to one value here. A helper that disagreed with itself would make every case in
 * this block fire for a reason the case is not about.
 */
const DESCRIPTION = 'Does a thing. Use when: you need the thing done.'

type PointerFields = NonNullable<Parameters<typeof pointerFixture>[0]>
type MetaFields = NonNullable<Parameters<typeof metaFixture>[0]>

const pointerContext = (
  pointer: PointerFields = {},
  meta: MetaFields = {},
): ContextFixtureOptions => ({
  universe: [
    pointerFixture({ description: DESCRIPTION, ...pointer }),
    metaFixture({ description: DESCRIPTION, ...meta }, `${CATALOG}/skill.meta`),
  ],
})

describe('install/pointer-mismatch', () => {
  it('does not fire on a pointer the installer generated', () => {
    expectDoesNotFire(pointerMismatch, null, pointerContext())
  })

  it('fires when the frontmatter `name` disagrees with the catalog', () => {
    const [finding] = expectFires(pointerMismatch, null, pointerContext({ name: 'renamed' }))

    expect(finding.path).toBe('.claude/skills/example/SKILL.md')
    expect(finding.related).toEqual([{ path: `${CATALOG}/skill.meta`, line: 1 }])
    expect(finding.message).toContain('`name` is `renamed`')
  })

  it('fires when the frontmatter `description` disagrees with the catalog', () => {
    const [finding] = expectFires(
      pointerMismatch,
      null,
      pointerContext({ description: 'Stale wording nobody updated.' }),
    )

    expect(finding.related).toEqual([{ path: `${CATALOG}/skill.meta`, line: 3 }])
    expect(finding.message).toContain('Stale wording')
  })

  it('does not fire when the two `description`s agree', () => {
    const description = 'Does a thing differently. Use when: you need it done differently.'
    expectDoesNotFire(pointerMismatch, null, pointerContext({ description }, { description }))
  })

  it('does not fire on the doubled apostrophe the installer’s YAML escaping writes', () => {
    // `yaml_escape` turns `'` into `''` inside a single-quoted scalar; `parseFrontmatter`
    // strips the quotes and leaves the doubling. Without undoing it, every description
    // containing an apostrophe reports as drifted against a correctly generated pointer.
    expectDoesNotFire(
      pointerMismatch,
      null,
      pointerContext(
        { description: "Reads the feature''s plan. Use when: planning." },
        { description: "Reads the feature's plan. Use when: planning." },
      ),
    )
  })

  it('fires when the body names another skill’s shared file', () => {
    const [finding] = expectFires(
      pointerMismatch,
      null,
      pointerContext({
        body: 'You MUST read `.agents/skills/other/SKILL.md` for the full procedure.',
      }),
    )

    expect(finding.message).toContain('`.agents/skills/other/SKILL.md`')
    expect(finding.related).toEqual([{ path: `${INSTALLED}/SKILL.md` }])
  })

  it('fires when the body names no shared file at all', () => {
    const [finding] = expectFires(
      pointerMismatch,
      null,
      pointerContext({ body: 'Just do the thing.' }),
    )

    expect(finding.message).toContain('names no shared skill file')
  })

  it('says nothing about a pointer whose catalog entry is not in scope', () => {
    // `--scope=installed` carries no `skill.meta` at all. Firing here would report all
    // sixteen pointers for a reason that is about the run rather than about a pointer.
    expectDoesNotFire(pointerMismatch, null, { universe: [pointerFixture()] })
  })
})

describe('the install family', () => {
  it('names both sides of every comparison it reports', () => {
    const findings = [
      ...runRule(
        catalogDrift,
        null,
        paired({ universe: [catalogFile('SKILL.md'), installedFile('SKILL.md', '# Edited\n')] }),
      ),
      ...runRule(
        versionBump,
        null,
        versionContext(unchangedBase(), catalogUniverse({ body: '# Rewritten\n' })),
      ),
      ...runRule(pointerMismatch, null, pointerContext({ name: 'renamed' })),
    ]

    expect(findings.length).toBe(3)
    for (const finding of findings) {
      // A drift finding that names one side tells the reader nothing about what to compare.
      expect(finding.related?.length ?? 0, finding.rule).toBeGreaterThan(0)
      expect(finding.path, finding.rule).not.toBe(finding.related?.[0]?.path)
    }
  })

  it('is three set-scoped rules', () => {
    expect(installRules.map((rule) => rule.id)).toEqual([
      'install/catalog-drift',
      'install/version-bump',
      'install/pointer-mismatch',
    ])
    for (const rule of installRules) expect(rule.scope, rule.id).toBe('set')
  })
})
