import { describe, expect, it } from 'vitest'

import { artifactFixture, expectDoesNotFire, expectFires } from '../test-helpers'

import { danglingPath, resolveReference } from './references'

/** The live defect, reproduced exactly: a reference next to a real `references/` directory. */
const COPYWRITING = 'tooling/skills/catalog/copywriting/references/natural-transitions.md'
const CATALOG_PATHS = [
  COPYWRITING,
  'tooling/skills/catalog/copywriting/SKILL.md',
  'tooling/skills/catalog/copywriting/skill.meta',
  'tooling/skills/catalog/copywriting/references/copy-frameworks.md',
  'AGENTS.md',
  '.specify/memory/constitution.md',
]

const reference = (content: string, path = COPYWRITING) =>
  artifactFixture({
    path,
    kind: 'catalog-reference',
    content,
    skillRoot: 'tooling/skills/catalog/copywriting',
  })

describe('refs/dangling-path', () => {
  it('fires on the live defect, naming the path and where it looked', () => {
    // `references/` exists next to that artifact; `references/ai-writing-detection.md`
    // does not, and there is no `seo-audit` skill anywhere in the catalog.
    const artifact = reference(
      'See the seo-audit skill’s `references/ai-writing-detection.md` for the full list.\n',
    )
    const [finding] = expectFires(danglingPath, artifact, { paths: CATALOG_PATHS })

    expect(finding.line).toBe(1)
    expect(finding.message).toContain('references/ai-writing-detection.md')
    expect(finding.message).toContain('does not exist relative to this artifact')
    expect(finding.remediation).toContain('prompt-lint-disable-next-line')
  })

  // Every case below is a shape the naive rule got wrong. The suite is asymmetric on
  // purpose: the naive rule produced 40+ hits and one true positive, and a suite that
  // only proved the true positive would not have caught that.
  describe('does not fire on', () => {
    it('a bare filename with no separator (rule 1)', () => {
      expectDoesNotFire(danglingPath, reference('Read spec.md, then plan.md.\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('a token carrying variable syntax (rule 2)', () => {
      expectDoesNotFire(
        danglingPath,
        reference('Read `$FEATURE_DIR/spec.md` and `{dir}/x.md` and `<root>/y.md`.\n'),
        { paths: CATALOG_PATHS },
      )
    })

    it('a SCREAMING_SNAKE path segment, which is Spec Kit variable syntax (rule 2)', () => {
      expectDoesNotFire(danglingPath, reference('Read `SPECIFY_FEATURE_DIRECTORY/spec.md`.\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('a path whose first segment is not a real directory in any root (rule 3)', () => {
      // A claim about a target project's tree, not about this repository.
      expectDoesNotFire(danglingPath, reference('Check `cdk/package.json` in the target.\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('a path inside a fenced block', () => {
      expectDoesNotFire(danglingPath, reference('```sh\ncat references/gone.md\n```\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('a path inside an HTML comment', () => {
      expectDoesNotFire(danglingPath, reference('<!-- references/gone.md -->\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('a path the line says may be absent (rule 5 — research R2’s runtime-created class)', () => {
      // 70 of the first real run's 80 findings were this one shape.
      const lines = [
        'Check if `.specify/extensions.yml` exists in the project root.\n',
        'If `.specify/extensions.yml` does not exist, skip silently.\n',
        'Persist the resolved path to `.specify/feature.json`.\n',
        'Write the value (for example, `specs/003-user-auth`) rather than the literal.\n',
        'e.g. in `.github/agents/`, `.github/skills/`, or your agent’s equivalent.\n',
      ]
      for (const line of lines) {
        expectDoesNotFire(danglingPath, reference(line), {
          paths: [...CATALOG_PATHS, '.specify/memory/constitution.md', '.github/workflows/ci.yml'],
        })
      }
    })

    it('a path that resolves against the artifact’s own directory', () => {
      expectDoesNotFire(danglingPath, reference('See `references/copy-frameworks.md`.\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('a path that resolves against the repository root', () => {
      expectDoesNotFire(
        danglingPath,
        reference('See `AGENTS.md` and `.specify/memory/constitution.md`.\n'),
        {
          paths: CATALOG_PATHS,
        },
      )
    })

    it('a URL', () => {
      expectDoesNotFire(danglingPath, reference('See https://qlty.sh/docs/install.md.\n'), {
        paths: CATALOG_PATHS,
      })
    })

    it('an artifact whose view could not be built', () => {
      expectDoesNotFire(danglingPath, artifactFixture({ readError: 'not-utf8' }), {
        paths: CATALOG_PATHS,
      })
    })
  })

  it('reports one finding per distinct reference on a line, not one per token match', () => {
    const artifact = reference('See `references/a.md` and `references/a.md` again.\n')
    expect(expectFires(danglingPath, artifact, { paths: CATALOG_PATHS })).toHaveLength(1)
  })

  describe('rule 5 reads the prose, not the reference', () => {
    // Rule 5 originally tested the whole line, so a filename containing one of its own
    // noise words silenced its own finding. Quickstart Scenario 4's fixture is named
    // `does-not-exist.md`, which is how this was caught — and the words at risk are
    // precisely the ones a placeholder filename is likely to use.
    it('fires on a path whose own filename contains a noise word', () => {
      const artifact = reference('See `references/does-not-exist.md` for the rest.\n')
      const [finding] = expectFires(danglingPath, artifact, { paths: CATALOG_PATHS })
      expect(finding.message).toContain('references/does-not-exist.md')
    })

    it.each([
      'references/missing-page.md',
      'references/optional-extras.md',
      'references/created-at-runtime.md',
      'references/absent.md',
    ])('fires on `%s`, whose filename alone must not exempt it', (path) => {
      const artifact = reference(`Read \`${path}\` before you begin.\n`)
      expect(expectFires(danglingPath, artifact, { paths: CATALOG_PATHS })).toHaveLength(1)
    })

    it('still exempts the surrounding sentence’s own existence check', () => {
      // The whole point of rule 5, and the case that must not regress: masking the
      // reference must not stop the *prose* from exempting it.
      expectDoesNotFire(
        danglingPath,
        reference('Check if `references/does-not-exist.md` exists before reading it.\n'),
        { paths: CATALOG_PATHS },
      )
    })
  })
})

describe('resolveReference', () => {
  const artifact = reference('x')
  const index = {
    has: (path: string) => CATALOG_PATHS.includes(path) || path === 'tooling/skills/catalog',
    isDirectory: (path: string) =>
      [
        'tooling',
        'tooling/skills',
        'tooling/skills/catalog',
        'tooling/skills/catalog/copywriting',
        'tooling/skills/catalog/copywriting/references',
        '.specify',
        '.specify/memory',
      ].includes(path),
    under: () => [],
  }

  it('tries the artifact directory, then the skill root, then the repo root', () => {
    // `references/copy-frameworks.md` resolves from the artifact's own directory.
    expect(resolveReference(artifact, 'references/copy-frameworks.md', index)).toMatchObject({
      claimed: true,
      exists: true,
    })
  })

  it('reports claimed-but-absent when a root’s first segment matched', () => {
    expect(resolveReference(artifact, 'references/gone.md', index)).toMatchObject({
      claimed: true,
      exists: false,
    })
  })

  it('reports unclaimed when no root has that first segment', () => {
    expect(resolveReference(artifact, 'cdk/package.json', index)).toMatchObject({ claimed: false })
  })

  it('resolves `..` out of the artifact’s directory', () => {
    expect(resolveReference(artifact, '../SKILL.md', index).exists).toBe(true)
  })
})
