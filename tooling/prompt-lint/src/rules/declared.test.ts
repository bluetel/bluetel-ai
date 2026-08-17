import { describe, expect, it } from 'vitest'

import { artifactFixture, expectDoesNotFire, expectFires, metaFixture } from '../test-helpers'

import { declaredDependencyMissing } from './declared'
import { unmetNeeds } from './define'

/**
 * A tracked-path set shaped like the real tree, because the rule's whole job is resolving
 * a declared name against it:
 *
 *  - `review` and `pr-creation` are real catalog skills, each with its `skill.meta`.
 *  - `half-built` is a catalog directory with no `skill.meta`. `expand_requires` reads the
 *    dependency's own metadata out of that file, so a directory without one is as
 *    unresolvable as a misspelt name — and this is the only fixture that tells the two
 *    apart.
 *  - `speckit` and `copywriting` are the two real asset bundles, each represented by a
 *    file under it: `buildPathIndex` derives directories from tracked files, so a bundle
 *    with no files in it is not a directory as far as any rule is concerned.
 *  - `notes.md` sits in `assets/` as a plain file, to pin the `isDirectory`-not-`has`
 *    choice: a file of the right name is not a bundle.
 */
const TRACKED = [
  'tooling/skills/catalog/review/skill.meta',
  'tooling/skills/catalog/review/SKILL.md',
  'tooling/skills/catalog/pr-creation/skill.meta',
  'tooling/skills/catalog/pr-creation/SKILL.md',
  'tooling/skills/catalog/half-built/SKILL.md',
  'tooling/skills/assets/speckit/.specify/templates/plan-template.md',
  'tooling/skills/assets/copywriting/.agents/copywriting-context.md',
  'tooling/skills/assets/notes.md',
]

const context = { paths: TRACKED }

/** Two real `next_step` lines, copied out of the live catalog, both well-formed. */
const REAL_NEXT_STEPS = [
  '/speckit-constitution|Fill in the project constitution. The installer seeds .specify/memory/constitution.md as an unfilled placeholder, and every other speckit command gates its spec, plan, tasks, and analysis against those principles — until it is ratified those gates check against nothing.|.specify/memory/constitution.md still contains [BRACKETED_PLACEHOLDER] tokens',
  // `skills-install` ships this one: a trailing separator with nothing after it. `when` is
  // optional, so an empty third field is well-formed and must stay silent.
  '/skills-install|Re-run this skill later to pull catalog updates. It re-fetches a fresh snapshot on demand and reports which installed skills are outdated, so no `curl … | sh` is needed again.|',
]

describe('meta/declared-dependency-missing declaration', () => {
  it('applies to skill.meta only — a pointer declares no dependencies', () => {
    expect(declaredDependencyMissing.appliesTo).toEqual(['catalog-meta'])
  })

  it('is gated on `meta` rather than guarding an unparsed block inside the check', () => {
    // The distinction the whole report rests on: an unreadable file is recorded as **not
    // evaluated** for this rule, not as passing it. That is `needs`' job, so the rule body
    // never has to decide what silence means.
    expect(declaredDependencyMissing.needs).toEqual(['meta'])
    const unreadable = artifactFixture({
      path: 'tooling/skills/catalog/example/skill.meta',
      kind: 'catalog-meta',
      readError: 'not-utf8',
    })
    expect(unmetNeeds(declaredDependencyMissing, unreadable)).toEqual(['meta'])
    expectDoesNotFire(declaredDependencyMissing, unreadable, context)
  })
})

describe('meta/declared-dependency-missing — requires=', () => {
  it('fires on a name that is not a catalog skill, naming it and the path looked for', () => {
    const [finding] = expectFires(
      declaredDependencyMissing,
      metaFixture({ requires: 'mis-typed-review' }),
      context,
    )
    expect(finding.message).toContain('`mis-typed-review`')
    expect(finding.message).toContain('tooling/skills/catalog/mis-typed-review/skill.meta')
  })

  it('fires once per offending word, because the value is space-separated', () => {
    // `for r in $_ve_req` word-splits, so one line can declare several dependencies. One
    // aggregated finding could not name which of them is broken.
    const findings = expectFires(
      declaredDependencyMissing,
      metaFixture({ requires: 'review nope review also-nope' }),
      context,
    )
    expect(findings).toHaveLength(2)
    expect(findings.map((finding) => finding.message).join(' ')).toContain('`also-nope`')
  })

  it('fires on a catalog directory that exists but carries no skill.meta', () => {
    // The directory is real, so a plain `isDirectory` check would pass it. It is still not
    // a skill anything can install.
    expectFires(declaredDependencyMissing, metaFixture({ requires: 'half-built' }), context)
  })

  it('reports the finding on the line the declaration is on', () => {
    const artifact = metaFixture({ requires: 'nope' })
    // name, version, description, requires — the fixture writes them in catalog order.
    expect(expectFires(declaredDependencyMissing, artifact, context)[0].line).toBe(4)
  })

  it('does not fire on a name that is a real catalog skill', () => {
    expectDoesNotFire(declaredDependencyMissing, metaFixture({ requires: 'review' }), context)
  })

  it('does not fire on several names that all resolve', () => {
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ requires: 'review pr-creation' }),
      context,
    )
  })

  it('does not fire on the literal `requires=` every catalog skill ships today', () => {
    // All seventeen carry the key with nothing after it. Empty and absent are the same
    // thing to the shell — zero iterations — and an unset optional field is not a defect.
    expectDoesNotFire(declaredDependencyMissing, metaFixture({ requires: '' }), context)
  })

  it('does not fire when the key is absent altogether', () => {
    const artifact = artifactFixture({
      path: 'tooling/skills/catalog/example/skill.meta',
      kind: 'catalog-meta',
      content: 'name=example\nversion=1.0.0\ndescription=Does a thing.\n',
    })
    expectDoesNotFire(declaredDependencyMissing, artifact, context)
  })

  it('reads only the first requires line, as meta_get does', () => {
    // A second line is `meta/duplicate-key`'s finding. Resolving a value the installer
    // never reads would report a defect in dead text — and miss one in live text.
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ requires: 'review', extraLines: ['requires=nope'] }),
      context,
    )
    const findings = expectFires(
      declaredDependencyMissing,
      metaFixture({ requires: 'nope', extraLines: ['requires=review'] }),
      context,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('`nope`')
  })
})

describe('meta/declared-dependency-missing — assets=', () => {
  it('fires on a bundle with no directory, naming it and where it was looked for', () => {
    const [finding] = expectFires(
      declaredDependencyMissing,
      metaFixture({ assets: 'mis-typed-speckit' }),
      context,
    )
    expect(finding.message).toContain('`mis-typed-speckit`')
    expect(finding.message).toContain('tooling/skills/assets/mis-typed-speckit')
  })

  it('fires when the name resolves to a file rather than a directory', () => {
    // A bundle is a file tree that gets copied into the target root, so `[ -d ]` is the
    // question — `index.has` is true of files too and would wave this through.
    expectFires(declaredDependencyMissing, metaFixture({ assets: 'notes.md' }), context)
  })

  it.each(['speckit', 'copywriting'])('does not fire on the real bundle `%s`', (bundle) => {
    expectDoesNotFire(declaredDependencyMissing, metaFixture({ assets: bundle }), context)
  })

  it('does not fire on the eleven catalog skills that declare no bundle', () => {
    expectDoesNotFire(declaredDependencyMissing, metaFixture(), context)
  })

  it('does not fire on an empty assets=', () => {
    expectDoesNotFire(declaredDependencyMissing, metaFixture({ assets: '' }), context)
  })

  it('resolves the bundle root as the catalog’s sibling, not relative to the skill', () => {
    // `assets_root()` is `$CATALOG/../assets`, and both roots are derived from the
    // artifact's own path. A catalog somewhere else has to keep working.
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ assets: 'bundle' }, 'vendor/skills/catalog/example/skill.meta'),
      { paths: ['vendor/skills/assets/bundle/file.md'] },
    )
    expectFires(declaredDependencyMissing, metaFixture({ assets: 'bundle' }), {
      paths: ['vendor/skills/assets/bundle/file.md'],
    })
  })
})

describe('meta/declared-dependency-missing — next_step=', () => {
  it('fires on a line with no separator, which states an action and no reason', () => {
    const [finding] = expectFires(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['gh auth status'] }),
      context,
    )
    expect(finding.message).toContain('gh auth status')
    expect(finding.message).toContain('action|why[|when]')
  })

  it('fires on an empty why — a bare instruction with no rationale', () => {
    // The one case tasks.md calls out by name: the field exists so the user can judge
    // whether the step applies rather than following it blindly, and an empty one renders
    // as an order.
    const [finding] = expectFires(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['gh auth status|'] }),
      context,
    )
    expect(finding.message).toContain('`why`')
    expect(finding.message).toContain('gh auth status')
  })

  it('fires on a why of nothing but whitespace, which the shell’s [ -n ] accepts', () => {
    // Deliberately stricter than `verify`: a single space passes `[ -n ]` and still renders
    // as no rationale at all.
    expectFires(declaredDependencyMissing, metaFixture({ nextSteps: ['gh auth status|   |'] }), {
      paths: TRACKED,
    })
  })

  it('fires on an empty action, and identifies the line by its value', () => {
    const [finding] = expectFires(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['|because it matters'] }),
      context,
    )
    expect(finding.message).toContain('`action`')
  })

  it('names both fields when both are empty', () => {
    const [finding] = expectFires(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['|'] }),
      context,
    )
    expect(finding.message).toContain('`action` and `why`')
  })

  it('fires once per offending line, since next_step is the one repeatable key', () => {
    const findings = expectFires(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['/a|why a', '/b|', '/c'] }),
      context,
    )
    expect(findings).toHaveLength(2)
    expect(findings.map((finding) => finding.line)).toEqual([6, 7])
  })

  it('does not fire on the two mandatory fields alone', () => {
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['gh auth status|Authenticate the GitHub CLI first.'] }),
      context,
    )
  })

  it('does not fire when the optional third field is supplied', () => {
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({
        nextSteps: ['gh auth status|Authenticate the GitHub CLI first.|`gh auth status` fails'],
      }),
      context,
    )
  })

  it('does not fire on the real catalog lines, including a trailing empty when', () => {
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ nextSteps: REAL_NEXT_STEPS }),
      context,
    )
  })

  it('does not fire on extra separators, which emit_next_steps folds into when', () => {
    // `_ens_when=${_ens_rest#*|}` takes everything after the second separator, so a fourth
    // field is rendered rather than lost. Firing on it would report a defect that is not one.
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ nextSteps: ['/a|why a|when a|and more prose'] }),
      context,
    )
  })

  it('does not fire when the key is absent — a skill need not declare a follow-up', () => {
    expectDoesNotFire(declaredDependencyMissing, metaFixture({ nextSteps: [] }), context)
  })
})

describe('meta/declared-dependency-missing — all three at once', () => {
  it('reports every offending declaration in one pass', () => {
    const findings = expectFires(
      declaredDependencyMissing,
      metaFixture({ requires: 'nope', assets: 'mis-typed-speckit', nextSteps: ['/a|'] }),
      context,
    )
    expect(findings).toHaveLength(3)
    // Every finding has to say what to do about it (FR-007, SC-006). `defineRule` throws on
    // an empty remediation, so this asserts they are useful rather than merely present.
    for (const finding of findings) expect(finding.remediation.length).toBeGreaterThan(20)
  })

  it('does not fire on a skill.meta shaped like the live catalog’s', () => {
    expectDoesNotFire(
      declaredDependencyMissing,
      metaFixture({ requires: '', assets: 'speckit', nextSteps: REAL_NEXT_STEPS }),
      context,
    )
  })
})
