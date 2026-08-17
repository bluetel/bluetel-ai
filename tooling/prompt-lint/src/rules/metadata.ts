/**
 * `meta/*` — metadata integrity.
 *
 * Every statement, rationale and fix here comes from
 * `specs/005-prompt-quality-validator/contracts/rules.md` verbatim. The catalogue is the
 * contract, not a summary written afterwards, and `registry.test.ts` cross-checks the
 * shipped copy in `docs/rules.md` against what is registered (FR-047, SC-010).
 */
import { metaGet } from '../artifact'
import type { MetaBlock } from '../artifact'
import type { ArtifactKind } from '../scope'

import { defineRule, requireArtifact, type FindingDraft } from './define'

const META_KINDS: ArtifactKind[] = ['catalog-meta', 'agent-pointer']

/** What each kind's metadata block must carry, non-empty. */
const REQUIRED_FIELDS: Partial<Record<ArtifactKind, string[]>> = {
  'catalog-meta': ['name', 'version', 'description'],
  'agent-pointer': ['name', 'description'],
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** The line a field is on, or the block's first line when it is absent entirely. */
const lineOf = (meta: MetaBlock, key: string): number =>
  meta.entries.find((entry) => entry.key === key)?.line ?? 1

export const requiredField = defineRule(
  {
    id: 'meta/required-field',
    defaultSeverity: 'error',
    statement:
      'Every field the kind requires is present and non-empty: name, version and description for skill.meta; name and description for a pointer’s frontmatter.',
    rationale:
      'The installer treats a missing description as a catalog error (exit 2) — a skill in that state cannot be listed or installed at all. An agent pointer without a description is invisible to skill selection.',
    appliesTo: META_KINDS,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['meta'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const meta = artifact.meta
    if (meta === null) return []

    return (REQUIRED_FIELDS[artifact.kind] ?? [])
      .filter((field) => (metaGet(meta, field) ?? '').trim().length === 0)
      .map((field) => ({
        line: lineOf(meta, field),
        message: `\`${field}\` is missing or empty.`,
        remediation:
          field === 'description'
            ? 'Add the field: one sentence of what the skill does, plus a `Use when:` clause naming the situations it applies to.'
            : `Add a non-empty \`${field}\`.`,
      }))
  },
)

export const duplicateKey = defineRule(
  {
    id: 'meta/duplicate-key',
    defaultSeverity: 'error',
    statement:
      'No key appears twice unless the format permits repetition. Only next_step is repeatable.',
    rationale:
      '`skills.sh`’s meta_get returns the first match, so a duplicated version means the value a reader sees and the value the installer uses can differ. That is the worst kind of defect — invisible on inspection.',
    appliesTo: META_KINDS,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['meta'],
  },
  (input) => {
    const meta = requireArtifact(input).meta
    if (meta === null) return []

    return meta.duplicates.map((duplicate) => ({
      line: duplicate.lines[duplicate.lines.length - 1],
      message: `\`${duplicate.key}\` appears ${String(duplicate.lines.length)} times (lines ${duplicate.lines.join(', ')}). Only the first is read.`,
      remediation: 'Delete the redundant line, or merge the two values if both were intended.',
    }))
  },
)

export const versionSemver = defineRule(
  {
    id: 'meta/version-semver',
    defaultSeverity: 'error',
    statement: 'version parses as MAJOR.MINOR.PATCH.',
    rationale:
      'The whole update mechanism is a version comparison. A value that does not parse makes "update available" undecidable for every target that installed the skill.',
    appliesTo: ['catalog-meta'],
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['meta'],
  },
  (input) => {
    const meta = requireArtifact(input).meta
    if (meta === null) return []

    const version = metaGet(meta, 'version')
    // An absent version is `meta/required-field`'s finding, not this rule's. Two rules
    // reporting one missing field is how a report starts getting skimmed.
    if (version === undefined || version.trim().length === 0) return []
    if (SEMVER.test(version)) return []

    return [
      {
        line: lineOf(meta, 'version'),
        message: `\`version\` is \`${version}\`, which is not MAJOR.MINOR.PATCH.`,
        remediation: 'Use three dot-separated integers, for example `1.0.0`.',
      },
    ]
  },
)

export const strayLine = defineRule(
  {
    id: 'meta/stray-line',
    defaultSeverity: 'warn',
    statement:
      'Every line in the metadata block is a comment or a well-formed key=value / key: value pair.',
    rationale:
      'A mistyped key — a missing `=`, a wrapped long description — is silently ignored by a line-oriented reader rather than rejected. The field looks set and is not.',
    appliesTo: META_KINDS,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['meta'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const meta = artifact.meta
    if (meta === null) return []

    const separator = meta.format === 'skill-meta' ? '=' : ': '
    return meta.strayLines.map<FindingDraft>((line) => ({
      line,
      message: `Line ${String(line)} is neither a comment nor a \`key${separator}value\` pair, so a line-oriented reader skips it.`,
      remediation:
        'Repair the line, or move prose into the `SKILL.md` body where it belongs. A long value must stay on one line.',
    }))
  },
)

export const metadataRules = [requiredField, duplicateKey, versionSemver, strayLine]
