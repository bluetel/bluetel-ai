/**
 * `meta/declared-dependency-missing` — the three `skill.meta` declarations that name
 * something outside the file they are written in.
 *
 * Every statement, rationale and fix here comes from
 * `specs/005-prompt-quality-validator/contracts/rules.md` verbatim, as in `metadata.ts`.
 *
 * `tooling/skills/lib/skills.sh`'s `verify` already gates all three (`catalog_die`, exit
 * `2`), so this rule is that gate moved earlier — before the push, rather than in a
 * target's install. Its semantics are therefore read off the shell rather than invented:
 *
 *  - `requires=` and `assets=` are read with `meta_get`, which returns the **first** match.
 *    Only the first line for each key is the value the installer resolves; a second one is
 *    `meta/duplicate-key`'s finding, and reporting a dependency nothing reads would be a
 *    finding about a dead value.
 *  - Both values are then **word-split** (`for r in $_ve_req`), so one line can declare
 *    several names.
 *  - Empty and absent are the same thing to the shell — zero iterations, no check — which
 *    is why neither fires here. Every skill in the catalog today ships a literal
 *    `requires=` with nothing after it and eleven of the seventeen ship no `assets=` at
 *    all; an optional field left unset is not a defect, and a rule that says otherwise
 *    fires seventeen times on a clean catalog.
 *  - `next_step=` is the one repeatable key (`meta_get_all`), so every line is checked.
 *
 * Nothing here touches the disk. Existence is a question for `input.index`, the single
 * tracked-file view `scope/` builds once, because a rule is a pure function over
 * already-loaded artifacts and two runs over one tree have to agree (research R2).
 */
import type { MetaBlock, MetaEntry } from '../artifact'
import type { ArtifactKind, PathIndex } from '../scope'

import { defineRule, requireArtifact, type FindingDraft } from './define'

const APPLIES_TO: ArtifactKind[] = ['catalog-meta']

/** POSIX dirname over a repo-relative path. Empty string at the repository root. */
const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

interface CatalogRoots {
  /** `$CATALOG` — the directory the per-skill directories sit in. */
  catalog: string
  /** `assets_root()`, which is `$CATALOG/../assets`. */
  assets: string
}

/**
 * Both roots, derived from the artifact's own path rather than hardcoded, exactly as the
 * shell derives them. A `catalog-meta` artifact is always `<catalog>/<name>/skill.meta`,
 * so `$CATALOG` is two levels up and the bundle root is its sibling.
 *
 * Hardcoding `tooling/skills/catalog` would make the rule silently stop matching the day
 * the catalog moves, and a rule that quietly checks nothing is worse than one that fails.
 */
const rootsFor = (artifactPath: string): CatalogRoots => {
  const catalog = parentOf(parentOf(artifactPath))
  return { catalog, assets: `${parentOf(catalog)}/assets` }
}

/** Shell word splitting: `for r in $value`. Empty and absent alike yield no words. */
const words = (value: string): string[] => value.split(/\s+/).filter((word) => word.length > 0)

/** The first entry for `key`, mirroring `meta_get`'s first-match-wins contract. */
const firstEntry = (meta: MetaBlock, key: string): MetaEntry | undefined =>
  meta.entries.find((entry) => entry.key === key)

const MAX_QUOTED = 60

/** A value short enough to sit in a report line. `next_step` values run to a paragraph. */
const quote = (value: string): string =>
  value.length <= MAX_QUOTED ? value : `${value.slice(0, MAX_QUOTED)}…`

interface PathDeclaration {
  key: string
  /** Where one declared word has to resolve. */
  target: (roots: CatalogRoots, word: string) => string
  /** What has to be there: a tracked `skill.meta` for a skill, a directory for a bundle. */
  present: (index: PathIndex, target: string) => boolean
  message: (word: string, target: string) => string
  remediation: string
}

/**
 * The two keys that name a path. One shared loop rather than two near-identical ones:
 * all that differs between them is a path shape, a predicate and a sentence, and a
 * per-key copy of the loop is exactly the duplication `defineRule` exists to keep out of
 * a change that adds fifteen rule modules (Constitution IV).
 */
const PATH_DECLARATIONS: PathDeclaration[] = [
  {
    key: 'requires',
    // The shell asks `[ -d $CATALOG/$r ] && [ -f $CATALOG/$r/skill.meta ]`. Testing the
    // file alone is equivalent and says more: it cannot exist without its directory, and
    // a catalog directory carrying no `skill.meta` is not a skill the installer can
    // resolve either — `expand_requires` reads the dependency's own `requires` out of
    // that file, so its absence is the same failure as a misspelt name.
    target: (roots, word) => `${roots.catalog}/${word}/skill.meta`,
    present: (index, target) => index.has(target),
    message: (word, target) =>
      `\`requires\` names \`${word}\`, which is not a skill in this catalog (looked for \`${target}\`).`,
    remediation:
      'Correct the name to match the catalog directory, or add the skill. `requires` is space-separated, so a stray word is a declared dependency that cannot be installed.',
  },
  {
    key: 'assets',
    target: (roots, word) => `${roots.assets}/${word}`,
    // `[ -d $(assets_root)/$a ]`. A bundle is a directory tree copied into the target, so
    // a plain file of that name is not one — which is why this asks `isDirectory` and not
    // `has`, the latter being true of files as well.
    present: (index, target) => index.isDirectory(target),
    message: (word, target) =>
      `\`assets\` names bundle \`${word}\`, which has no directory (looked for \`${target}\`).`,
    remediation:
      'Correct the bundle name, or add the bundle: a directory under `assets/` whose file tree is laid out relative to the target root.',
  },
]

const EXPECTED_SHAPE = 'Expected `action|why[|when]`.'

/**
 * One `next_step=` line, mirroring `verify`'s two branches: no separator at all, and a
 * separator with one of the two mandatory fields empty.
 *
 * `when` is optional **and may be empty**: `skills-install` ships a line ending in a bare
 * `|`, and that is well-formed. Extra separators are not a defect either — `emit_next_steps`
 * assigns everything after the second one to `when` (`${rest#*|}`), so a fourth field is
 * rendered rather than swallowed, and firing on it would report a defect that does not exist.
 *
 * Emptiness is `trim()`ed where the shell's `[ -n ]` is not. A `why` of one space satisfies
 * the shell and still renders as a bare instruction with no rationale, which is precisely
 * what the field exists to prevent.
 */
const nextStepFinding = (entry: MetaEntry): FindingDraft | null => {
  const fields = entry.value.split('|')

  if (fields.length < 2) {
    return {
      line: entry.line,
      message: `\`next_step\` \`${quote(entry.value)}\` carries no \`|\`, so it states an action with no reason. ${EXPECTED_SHAPE}`,
      remediation:
        'Append `|` and one sentence of why the step matters. It is shown verbatim, so the user can judge whether it applies to their project instead of following an instruction blindly.',
    }
  }

  const action = fields[0].trim()
  const missing = [
    ...(action.length === 0 ? ['action'] : []),
    ...(fields[1].trim().length === 0 ? ['why'] : []),
  ]
  if (missing.length === 0) return null

  // Identify the line by its action where there is one: that is what a reader recognises,
  // and a `why` runs to a paragraph.
  const label = action.length === 0 ? quote(entry.value) : action
  return {
    line: entry.line,
    message: `\`next_step\` \`${label}\` is missing its \`${missing.join('` and `')}\`. ${EXPECTED_SHAPE}`,
    remediation: missing.includes('why')
      ? 'Supply the reason between the first and second `|`. It is shown verbatim, so the user can judge whether the step applies to their project instead of following an instruction blindly.'
      : 'Supply the concrete thing to do before the first `|` — `/speckit-constitution`, `gh auth status`, `Set jira_board_id`.',
  }
}

export const declaredDependencyMissing = defineRule(
  {
    id: 'meta/declared-dependency-missing',
    defaultSeverity: 'error',
    statement:
      'requires= names skills that exist in the catalog; assets= names a bundle directory under assets/; each next_step= line carries its two mandatory |-separated fields (action, why), with an optional third (when).',
    rationale:
      '`tooling/skills/README.md` already states that a declared bundle that does not exist is a catalog error (exit 2) — this catches it before the push rather than in a target’s install. A `next_step` missing its `why` renders as a bare instruction with no rationale, which is precisely what that field exists to prevent.',
    appliesTo: APPLIES_TO,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['meta'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const meta = artifact.meta
    // `needs: ['meta']` is what handles a block that could not be parsed: the evaluator
    // records this rule **not evaluated** for that artifact rather than as passing. This
    // line is only the type narrowing that follows from it.
    if (meta === null) return []

    const roots = rootsFor(artifact.path)
    const findings: FindingDraft[] = []

    for (const declaration of PATH_DECLARATIONS) {
      const entry = firstEntry(meta, declaration.key)
      if (entry === undefined) continue
      for (const word of words(entry.value)) {
        const target = declaration.target(roots, word)
        if (declaration.present(input.index, target)) continue
        // One finding per offending word, not one per key: a message that cannot name the
        // value it is about is a message that sends the reader back to the file to guess
        // which of three declared names is the broken one.
        findings.push({
          line: entry.line,
          message: declaration.message(word, target),
          remediation: declaration.remediation,
        })
      }
    }

    for (const entry of meta.entries) {
      if (entry.key !== 'next_step') continue
      const finding = nextStepFinding(entry)
      if (finding !== null) findings.push(finding)
    }

    return findings
  },
)
