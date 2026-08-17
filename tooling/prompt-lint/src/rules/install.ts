/**
 * `install/*` — the catalog-to-target contract, and the only three rules that reason
 * about **two trees at once**. Each one pairs a file in one tree with a file in another
 * and reports a relationship, so every finding names both paths via `related`: a drift
 * finding that names one side tells the reader nothing about what to compare.
 *
 * **Two facts about the declared set shape all three rules** (`scope/patterns.ts`):
 *
 *  1. The universe carries **only markdown** from the installed tree — that location's
 *     declared glob starts one skill directory down and ends in `.md` — and, from the
 *     catalog, only `SKILL.md`, `skill.meta` and the markdown under `references`.
 *     `.skill`, `.agents/skills.config`, asset
 *     bundles, `references/findings-schema.json` and `scripts/jira-sprint.sh` are **not
 *     declared artifacts at all**, so no `Artifact` — and therefore no `content` — ever
 *     exists for them. The current bytes of a file are available only through
 *     `Artifact.content`; `PathIndex` knows which paths exist and nothing about what is in
 *     them. So the comparison is split: **file lists** are compared over every tracked
 *     path (`index.under`), **contents** only over the paths the universe carries. A file
 *     that exists on both sides and is not a declared artifact is checked for presence and
 *     not for content — widening that is a `patterns.ts` change, not this module's.
 *  2. `--scope=catalog` and `--scope=installed` each hand these rules **half a pair**.
 *     Every check below therefore stays silent when the counterpart is absent from the
 *     universe rather than reporting the absence as a defect: under `--scope=installed`
 *     there is no `skill.meta` to compare a pointer against, and a rule that fired on that
 *     would fire on all sixteen pointers for a reason that is about the run.
 *
 * **The per-project exclusion list is taken from the installer, not from the design.**
 * `tooling/skills/lib/skills.sh` is the authority twice over: `stage_and_commit` copies
 * `find . -type f ! -name skill.meta`, and `skill_hash` digests
 * `find . -type f ! -name skill.meta ! -name .skill`. So the two files outside the
 * comparison are `skill.meta` (catalog-only, never copied) and `.skill` (installed-only,
 * generated per project). `.agents/skills.config` and the asset bundles — the two the design
 * names — live *outside* both compared directories entirely: the config sits at
 * `.agents/skills.config`, and `install_bundle` seeds bundle files into `.specify/`. They
 * cannot drift a skill directory, so excluding them by name would be dead code.
 *
 * **Measured against the real trees before it shipped**, the same way `references.ts`
 * checked its algorithm rather than trusting the design: all sixteen installed skills
 * match their catalog entry byte for byte once `skill.meta` and `.skill` are excluded, and
 * all sixteen pointers agree with their `skill.meta`. `frontend-design` is published in the
 * catalog and installed in neither tree, which is why a skill present on only one side is
 * silence — a catalog publishes to many targets and each installs the subset it wants.
 * Reporting it would have made `install/catalog-drift` fire on a clean tree, against the
 * contract's verified count of zero pre-existing violations.
 */
import { metaGet, parseSkillMeta } from '../artifact'
import type { Artifact } from '../artifact'
import { skillNameOf } from '../scope'
import type { ArtifactKind, PathIndex } from '../scope'

import { defineRule } from './define'
import type { DiffContext, FindingDraft, LocalRule, RuleContext, RuleId } from './define'

const CATALOG_ROOT = 'tooling/skills/catalog'
const INSTALLED_ROOT = '.agents/skills'
const POINTER_ROOT = '.claude/skills'

/** Last segment of a repo-relative path. */
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** A path relative to the skill directory it sits in: `SKILL.md`, `references/x.md`. */
const relativeTo = (root: string, path: string): string => path.slice(root.length + 1)

/**
 * The two files the installer deliberately keeps out of the content it copies and hashes.
 * See the header: this list is `skills.sh`'s, not the design's.
 */
const PER_PROJECT_FILES = new Set(['skill.meta', '.skill'])

const isPerProject = (relative: string): boolean => PER_PROJECT_FILES.has(basenameOf(relative))

/** Every artifact in the universe by path — the only source of current bytes a set rule has. */
const byPath = (universe: readonly Artifact[]): Map<string, Artifact> =>
  new Map(universe.map((artifact) => [artifact.path, artifact]))

/**
 * The skill directories under one of the three trees, by name, from the tracked file list.
 *
 * The `isDirectory` guard is load-bearing: `.agents/skills/README.md` is a tracked file
 * directly under the installed root, and `skillNameOf` reads its first segment as the
 * skill name. Without the guard the installed tree grows a skill called `README.md`.
 */
const skillNamesUnder = (index: PathIndex, tree: string): string[] => {
  const names = new Set<string>()
  for (const path of index.under(tree)) {
    const name = skillNameOf(path)
    if (name !== null && index.isDirectory(`${tree}/${name}`)) names.add(name)
  }
  return [...names].sort()
}

/** Comparable files under a skill directory, relative to it, per-project files removed. */
const comparableFiles = (index: PathIndex, root: string): string[] =>
  index
    .under(root)
    .map((path) => relativeTo(root, path))
    .filter((relative) => !isPerProject(relative))
    .sort()

/** A skill published in the catalog and installed in this repository. */
interface SkillPair {
  name: string
  catalogRoot: string
  installedRoot: string
}

/**
 * Skills present in **both** trees. A skill in only one is not a pair and not a defect —
 * see the header on `frontend-design`.
 */
const pairedSkills = (index: PathIndex): SkillPair[] => {
  const installed = new Set(skillNamesUnder(index, INSTALLED_ROOT))
  return skillNamesUnder(index, CATALOG_ROOT)
    .filter((name) => installed.has(name))
    .map((name) => ({
      name,
      catalogRoot: `${CATALOG_ROOT}/${name}`,
      installedRoot: `${INSTALLED_ROOT}/${name}`,
    }))
}

/**
 * Compare one file the two trees agree exists. Returns null when the pair cannot be
 * compared byte for byte — either side is outside the declared set, or its content could
 * not be read. Both cases are silence here and an entry from `notEvaluatedSetRules`; a
 * rule may not report "these files differ" on the strength of bytes it never saw.
 */
const contentsDiffer = (
  artifacts: Map<string, Artifact>,
  catalogPath: string,
  installedPath: string,
): boolean | null => {
  const catalog = artifacts.get(catalogPath)?.content
  const installed = artifacts.get(installedPath)?.content
  if (catalog === undefined || catalog === null) return null
  if (installed === undefined || installed === null) return null
  return catalog !== installed
}

/**
 * One finding per differing file, not one per skill. The remediation is per file — this
 * is the file to reconcile — and a skill-level finding would name a directory and leave
 * the reader to run the diff themselves. Noise is bounded because every finding is a real
 * byte difference rather than a heuristic.
 *
 * A file **missing on one side** and a file **present on both and differing** are separate
 * defects and get separate messages: the first is an incomplete install or an
 * uninstalled catalog addition, the second is an edit made in the wrong tree. The finding
 * is reported at the installed copy wherever one exists, because that is the file whose
 * hash `skills.sh status` compares and the file whose divergence freezes updates. When
 * the installed copy is the side that does not exist there is nothing to report it at, so
 * that one finding is reported at the catalog file and names the expected path in
 * `related`.
 */
const driftInSkill = (
  pair: SkillPair,
  index: PathIndex,
  artifacts: Map<string, Artifact>,
): FindingDraft[] => {
  const catalogFiles = comparableFiles(index, pair.catalogRoot)
  const installedFiles = new Set(comparableFiles(index, pair.installedRoot))
  const drafts: FindingDraft[] = []

  for (const relative of catalogFiles) {
    const catalogPath = `${pair.catalogRoot}/${relative}`
    const installedPath = `${pair.installedRoot}/${relative}`

    if (!installedFiles.has(relative)) {
      drafts.push({
        path: catalogPath,
        related: [{ path: installedPath }],
        message: `\`${relative}\` is in the catalog entry for \`${pair.name}\` and missing from the installed copy at \`${pair.installedRoot}/\`.`,
        remediation: `Re-run the installer for \`${pair.name}\` so the installed copy carries every catalog file, or delete the file from the catalog if it was never meant to ship.`,
      })
      continue
    }

    if (contentsDiffer(artifacts, catalogPath, installedPath) !== true) continue
    drafts.push({
      path: installedPath,
      related: [{ path: catalogPath }],
      message: `Does not match \`${catalogPath}\` byte for byte, so \`skills.sh status\` reports \`${pair.name}\` locally-modified and \`update\` will refuse to touch it.`,
      remediation: `Make the edit in \`${pair.catalogRoot}/\` and re-run the installer, or accept the installed copy as the new catalog content. Never both.`,
    })
  }

  const inCatalog = new Set(catalogFiles)
  for (const relative of installedFiles) {
    if (inCatalog.has(relative)) continue
    drafts.push({
      path: `${pair.installedRoot}/${relative}`,
      related: [{ path: `${pair.catalogRoot}/${relative}` }],
      message: `Is in the installed copy of \`${pair.name}\` and in no catalog entry, so the next \`update\` deletes it.`,
      remediation: `Add the file to \`${pair.catalogRoot}/\` if the skill needs it, or delete it from the installed copy. Installed content is replaced wholesale, never merged.`,
    })
  }

  return drafts
}

const DRIFT_KINDS: ArtifactKind[] = ['catalog-skill', 'catalog-reference', 'installed-skill']

export const catalogDrift = defineRule(
  {
    id: 'install/catalog-drift',
    defaultSeverity: 'error',
    statement:
      '`.agents/skills/<name>/` matches `tooling/skills/catalog/<name>/` byte for byte, excluding the two files the installer deliberately leaves per-project: `skill.meta`, which it never copies, and `.skill`, which it generates.',
    rationale:
      'The installer’s update model is a content hash. When the installed copy diverges, `skills.sh status` reports the skill locally-modified and `update` refuses to touch it without `--on-conflict`. A drift introduced by editing the installed copy instead of the catalog therefore freezes that skill’s updates — in this repo, and in every target that later hits the same conflict.',
    appliesTo: DRIFT_KINDS,
    dimension: 'correctness',
    scope: 'set',
  },
  (input) => {
    const artifacts = byPath(input.universe)
    return pairedSkills(input.index).flatMap((pair) => driftInSkill(pair, input.index, artifacts))
  },
)

/**
 * The hashed content files of one catalog skill that this diff changed, by path.
 *
 * "Changed" is decided from `DiffContext.at` alone — no second read of the disk — and it
 * has three shapes, because `at` answers a different question for each:
 *
 *  - **added**: `at` returns null for a path the index says is tracked now.
 *  - **modified**: `at` returns bytes that differ from the artifact's current `content`.
 *  - **deleted**: the path is in `context.deleted`, which `at` cannot tell us because the
 *    file is absent from the index it would be looked up in.
 *
 * A tracked file the universe does not carry (a script, a JSON schema) is detectable as
 * added or deleted but not as modified: there are no current bytes for it. That is a
 * missed defect and it is stated rather than hidden — a bump missed on a changed
 * `scripts/jira-sprint.sh` is the one case this rule cannot see.
 */
const changedContentFiles = (
  context: RuleContext,
  diff: DiffContext,
  catalogRoot: string,
  artifacts: Map<string, Artifact>,
): string[] => {
  const changed: string[] = []

  for (const path of context.index.under(catalogRoot)) {
    if (isPerProject(relativeTo(catalogRoot, path))) continue
    const base = diff.at(path)
    if (base === null) {
      changed.push(path)
      continue
    }
    const current = artifacts.get(path)?.content
    // Undefined: not a declared artifact. Null: unreadable, and reported by
    // `notEvaluatedSetRules` rather than guessed at here.
    if (current === undefined || current === null) continue
    if (current !== base) changed.push(path)
  }

  for (const path of context.deleted) {
    if (!path.startsWith(`${catalogRoot}/`)) continue
    if (isPerProject(relativeTo(catalogRoot, path))) continue
    changed.push(path)
  }

  return changed.sort()
}

/** The 1-indexed line a metadata field sits on, or the block's first line when absent. */
const lineOfField = (artifact: Artifact, key: string): number =>
  artifact.meta?.entries.find((entry) => entry.key === key)?.line ?? 1

export const versionBump = defineRule(
  {
    id: 'install/version-bump',
    defaultSeverity: 'error',
    statement:
      'When a diff changes a catalog skill’s hashed content, that skill’s `skill.meta` `version` also changes.',
    rationale:
      'The version is the only signal a target has. Content changed without a bump means no installed copy anywhere will ever learn there is an update — the change is published and invisible at the same time.',
    appliesTo: ['catalog-skill', 'catalog-meta', 'catalog-reference'],
    dimension: 'correctness',
    scope: 'set',
  },
  (input) => {
    const diff = input.diff
    // No base ref: `--all` compares nothing, so this rule has not run. It reports **nothing**
    // here and is named by `notEvaluatedSetRules` instead — an empty finding list from a rule
    // that could not run is indistinguishable from a pass, which is the failure mode the whole
    // report exists to rule out.
    if (diff === null) return []

    const artifacts = byPath(input.universe)
    const drafts: FindingDraft[] = []

    for (const name of skillNamesUnder(input.index, CATALOG_ROOT)) {
      const catalogRoot = `${CATALOG_ROOT}/${name}`
      const metaPath = `${catalogRoot}/skill.meta`
      // No `skill.meta` in the universe at all — `--scope=installed` hands this rule half a
      // pair, and a catalog entry with no metadata is `meta/required-field`'s finding.
      const meta = artifacts.get(metaPath)
      if (meta === undefined) continue
      const currentMeta = meta.meta
      if (currentMeta === null) continue

      const baseMeta = diff.at(metaPath)
      // The skill did not exist at the base ref. A first published version is not a bump.
      if (baseMeta === null) continue

      const current = metaGet(currentMeta, 'version')
      const base = metaGet(parseSkillMeta(baseMeta), 'version')
      // An absent version on either side is `meta/required-field`'s finding. Two rules
      // reporting one missing field is how a report starts getting skimmed.
      if (current === undefined || base === undefined) continue
      if (current !== base) continue

      const changed = changedContentFiles(input, diff, catalogRoot, artifacts)
      if (changed.length === 0) continue

      drafts.push({
        path: metaPath,
        line: lineOfField(meta, 'version'),
        related: changed.map((path) => ({ path })),
        message: `\`${name}\` changed ${String(changed.length)} hashed content file(s) since \`${diff.baseRef}\` — ${changed.join(', ')} — and \`version\` is still \`${current}\`.`,
        remediation:
          'Bump `version` in the same commit. Patch for wording, minor for a new capability, major for a changed contract.',
      })
    }

    return drafts
  },
)

/**
 * The installer writes the pointer's `description` as a single-quoted YAML scalar through
 * `yaml_escape`, which doubles every `'`. `parseFrontmatter` strips the surrounding quotes
 * and leaves the doubling, so a catalog description containing an apostrophe would
 * otherwise compare unequal against a pointer the installer had just generated correctly.
 * Undoing it here can only misread a description that genuinely contains `''`, which no
 * description in the catalog does and none plausibly would.
 */
const unescapeYamlQuotes = (value: string): string => value.split("''").join("'")

/** The shared-skill file a pointer body names, whichever skill it belongs to. */
const SHARED_FILE_REFERENCE = /\.agents\/skills\/[^\s`)]+\/SKILL\.md/

/**
 * One finding per disagreeing field, each naming the `skill.meta` line it disagrees with.
 * Per field rather than per pointer, because `name`, `description` and the body reference
 * have three different fixes, and a combined message would have to carry all three.
 */
const pointerDrafts = (pointer: Artifact, meta: Artifact, name: string): FindingDraft[] => {
  const pointerMeta = pointer.meta
  const catalogMeta = meta.meta
  // Either block unparsed is `meta/stray-line`'s and `artifact/unreadable`'s territory.
  if (pointerMeta === null || catalogMeta === null) return []

  const drafts: FindingDraft[] = []

  for (const field of ['name', 'description'] as const) {
    const expected = metaGet(catalogMeta, field)
    const actual = metaGet(pointerMeta, field)
    // An absent field on either side is `meta/required-field`'s finding.
    if (expected === undefined || actual === undefined) continue
    if (unescapeYamlQuotes(actual) === expected) continue

    drafts.push({
      path: pointer.path,
      line: lineOfField(pointer, field),
      related: [{ path: meta.path, line: lineOfField(meta, field) }],
      message: `Frontmatter \`${field}\` is \`${actual}\`, but \`${meta.path}\` says \`${expected}\`.`,
      remediation:
        'Regenerate the pointer through the installer rather than editing it by hand — the pointer is generated from `skill.meta`, so the catalog is where the value belongs.',
    })
  }

  const shared = `${INSTALLED_ROOT}/${name}/SKILL.md`
  const body = pointer.content ?? ''
  if (!body.includes(shared)) {
    const named = SHARED_FILE_REFERENCE.exec(body)?.[0]
    drafts.push({
      path: pointer.path,
      related: [{ path: shared }],
      message:
        named === undefined
          ? `Body names no shared skill file, so an agent that reads this pointer runs a one-sentence stub as if it were the whole procedure. Expected \`${shared}\`.`
          : `Body names \`${named}\` rather than \`${shared}\`, so an agent that reads this pointer follows another skill's procedure.`,
      remediation: `Regenerate the pointer through the installer, whose \`generate_stub\` writes one line: You MUST read and follow the shared skill file at \`${shared}\` for the full procedure.`,
    })
  }

  return drafts
}

export const pointerMismatch = defineRule(
  {
    id: 'install/pointer-mismatch',
    defaultSeverity: 'error',
    statement:
      'A `.claude/skills/<name>/SKILL.md` pointer’s frontmatter `name` and `description` match the catalog `skill.meta`, and its body references the shared `.agents/skills/<name>/SKILL.md` file.',
    rationale:
      'The pointer is what the agent reads first. If its `description` has drifted from the catalog’s, skill selection is made on stale information; if it stops naming the shared file, the agent runs a one-sentence stub as if it were the whole procedure.',
    appliesTo: ['agent-pointer', 'catalog-meta'],
    dimension: 'correctness',
    scope: 'set',
  },
  (input) => {
    const artifacts = byPath(input.universe)
    const drafts: FindingDraft[] = []

    for (const pointer of input.universe) {
      if (pointer.kind !== 'agent-pointer') continue
      if (!pointer.path.startsWith(`${POINTER_ROOT}/`)) continue

      const name = skillNameOf(pointer.path)
      if (name === null) continue

      const meta = artifacts.get(`${CATALOG_ROOT}/${name}/skill.meta`)
      // No catalog entry in the universe: the pointer may name a skill published by another
      // catalog, and under `--scope=installed` there is no `skill.meta` in scope at all. A
      // missing installed copy or a missing pointer is likewise silence — `skills.sh status`
      // owns the installer's own states (stub-missing, not-installed), and prompt-lint owns
      // the content of the artifacts that are there.
      if (meta === undefined) continue

      drafts.push(...pointerDrafts(pointer, meta, name))
    }

    return drafts
  },
)

/** A set-scoped rule that could not run in this scope, and why. */
export interface SetRuleSkip {
  rule: RuleId
  reason: string
}

/** Which trees each set-scoped rule reads, so an unreadable file in one is traceable to it. */
const SET_RULE_TREES: { rule: LocalRule; trees: string[] }[] = [
  { rule: catalogDrift, trees: [CATALOG_ROOT, INSTALLED_ROOT] },
  { rule: versionBump, trees: [CATALOG_ROOT] },
  { rule: pointerMismatch, trees: [CATALOG_ROOT, POINTER_ROOT] },
]

/**
 * The `notEvaluated` entries the set-scoped rules owe this run.
 *
 * `gate.ts` builds its `notEvaluated` list from `unmetNeeds`, which takes an artifact — so
 * it covers per-artifact rules only, and a set-scoped rule that could not run has nowhere
 * to say so. This is that channel, in the shape `Report.notEvaluated` already holds, for
 * `gate.ts` to concatenate. Two causes:
 *
 *  - **no base ref** — `install/version-bump` is a comparison between two revisions, and
 *    `--all` compares nothing. Reporting it as passing would mean the whole-surface run
 *    silently claims every version is bumped correctly.
 *  - **an unreadable participant** — a rule cannot conclude two files match when it could
 *    not read one of them. `artifact/unreadable` names the file; this names the comparison
 *    that did not happen because of it.
 */
export const notEvaluatedSetRules = (context: RuleContext): SetRuleSkip[] => {
  const skips: SetRuleSkip[] = []

  if (context.diff === null) {
    skips.push({
      rule: versionBump.id,
      reason:
        'compares a catalog skill against the base ref, and this run has no base ref to compare against',
    })
  }

  for (const { rule, trees } of SET_RULE_TREES) {
    const unreadable = context.universe.filter(
      (artifact) =>
        artifact.content === null && trees.some((tree) => artifact.path.startsWith(`${tree}/`)),
    )
    if (unreadable.length === 0) continue
    skips.push({
      rule: rule.id,
      reason: `could not compare ${unreadable.map((artifact) => artifact.path).join(', ')} against the other tree (unreadable)`,
    })
  }

  return skips
}

export const installRules = [catalogDrift, versionBump, pointerMismatch]
