/**
 * `skill/use-when-trigger` — does the description say *when*, not only *what* (FR-014).
 *
 * The description is the only thing an agent sees when deciding whether to invoke a
 * skill: the body is not read until after the decision. A description that says only
 * what a skill does therefore gets it selected by name — someone typed `speckit-plan`,
 * so the plan skill runs — rather than by need, which is the failure this rule exists to
 * make visible. Ten of the seventeen catalog skills are in exactly that state today.
 *
 * Both kinds this applies to reach the same shape: `skill.meta`'s `key=value` lines and a
 * `.claude/` pointer's `---` frontmatter are parsed by two different readers into one
 * `MetaBlock`, so the check reads `description` once and neither parser appears here.
 *
 * A missing or empty `description` is **not** this rule's finding. `meta/required-field`
 * already reports it, and its remediation already names the `Use when:` clause — two
 * rules reporting one missing field is how a report starts getting skimmed.
 */
import { metaGet } from '../artifact'
import type { ArtifactKind } from '../scope'

import { defineRule, requireArtifact } from './define'

const APPLIES_TO: ArtifactKind[] = ['catalog-meta', 'agent-pointer']

/**
 * The trigger marker, matched deliberately more loosely than the canonical `Use when:`.
 *
 * All seven passing descriptions write the canonical form exactly, so a stricter literal
 * would pass the corpus too — but the corpus is not the only input. `copywriting`'s own
 * skill body already writes `Also use when the user says …` with no colon, which is the
 * same clause doing the same job, and a rule that reported it would be teaching authors
 * to satisfy punctuation rather than to name a situation. So: case-insensitive, the colon
 * optional, an optional `this`/`it` after `use`, and `whenever` as well as `when`.
 *
 * Rejected, and intentionally: `Useful when` (a different word), a bare `When:` with no
 * `use` (which reads as a section label, not a trigger), and near-synonyms like
 * `Triggers on:` or `Applies to:`. The clause the contract names is `Use when:`; a warn
 * that accepts every phrasing of every intent is not measuring anything.
 */
const MARKER = /\buse\s+(?:this\s+|it\s+)?when(?:ever)?\b\s*:?/i

/**
 * How many words must follow the marker before the clause names a *situation*.
 *
 * `Use when: needed.` satisfies any substring test while naming nothing, so the marker
 * alone cannot be the whole check. Three is a judgement and worth stating as one: it is
 * the shortest span that can carry a verb and its object — `creating a ticket`,
 * `reviewing code changes` — where one or two words can only be an adjective standing in
 * for a situation (`needed`, `relevant`, `if appropriate`). The shortest real clause in
 * the catalog, `skills-install`'s, runs to six words, so the threshold has clearance
 * against the corpus rather than being tuned to it.
 */
const MIN_SITUATION_WORDS = 3

/** Whitespace-separated tokens carrying at least one letter or digit. */
const countWords = (text: string): number =>
  text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length

export const useWhenTrigger = defineRule(
  {
    id: 'skill/use-when-trigger',
    defaultSeverity: 'warn',
    statement:
      'The `description` contains a `Use when:` clause naming the situations the skill applies to.',
    rationale:
      'The description is the only thing an agent sees when deciding whether to invoke a skill. The ten speckit-* skills describe what they do but never when, which is why they get selected by name rather than by need.',
    appliesTo: APPLIES_TO,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['meta'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const meta = artifact.meta
    if (meta === null) return []

    const description = metaGet(meta, 'description') ?? ''
    // An absent or empty description is `meta/required-field`'s finding, not this one's.
    if (description.trim().length === 0) return []

    const line = meta.entries.find((entry) => entry.key === 'description')?.line ?? 1
    const marker = MARKER.exec(description)

    if (marker === null) {
      return [
        {
          line,
          message:
            '`description` has no `Use when:` clause — it says what the skill does but never when to reach for it, so an agent can only select it by name.',
          remediation:
            'Append `Use when: <situation>, <situation>` to the description. Describe the user’s situation, not the command’s mechanics.',
        },
      ]
    }

    const situation = description.slice(marker.index + marker[0].length)
    if (countWords(situation) >= MIN_SITUATION_WORDS) return []

    return [
      {
        line,
        message: `\`description\` has a \`${marker[0].trim()}\` marker but names no situation after it${situation.trim().length === 0 ? '' : ` — only \`${situation.trim()}\``}.`,
        remediation:
          'Name the situations that should bring an agent here — what the user is doing or asking for — rather than a placeholder like “needed”.',
      },
    ]
  },
)
