/**
 * `template/placeholder-residue` — is it finished.
 *
 * An agent reading a placeholder treats it as content. A `skill.meta` `next_step` in this
 * very repository checks for exactly this condition — "`.specify/memory/constitution.md`
 * still contains bracketed placeholder tokens" — which is a rule expressed as prose
 * because there was no linter to hold it.
 *
 * **Inverted for `speckit-template`**: there the tokens are the template's _content_, so
 * the rule instead checks that they are still **present**. A template accidentally filled
 * in place and shipped would produce one repository's spec for every future feature.
 *
 * Code spans, fenced blocks and HTML comments are exempt throughout, and that exemption
 * is load-bearing rather than a nicety: it is what lets the constitution's SYNC IMPACT
 * REPORT comment quote the tokens, and what lets this feature's own `docs/rules.md` quote
 * every token it matches.
 */
import type { MarkdownView, Range } from '../artifact'
import { inRanges } from '../artifact'
import type { ArtifactKind } from '../scope'

import { defineRule, requireArtifact, type FindingDraft } from './define'

const APPLIES_TO: ArtifactKind[] = [
  'catalog-skill',
  'catalog-reference',
  'installed-skill',
  'agent-pointer',
  'guidance',
  'constitution',
  'speckit-template',
]

interface PlaceholderPattern {
  /** What it is, for the message. */
  label: string
  pattern: RegExp
}

const ARGUMENT_SLOT_LABEL = 'the argument slot'

const PATTERNS: readonly PlaceholderPattern[] = [
  {
    label: 'a bracketed template slot',
    // SCREAMING_SNAKE or Title Case inside square brackets, which is how every Spec Kit
    // template writes a slot. A markdown checkbox (`[ ]`, `[x]`) is not one.
    pattern: /\[(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][a-z]+(?: [A-Z][a-z]+)+)\]/g,
  },
  { label: 'a clarification marker', pattern: /NEEDS[ _]CLARIFICATION/g },
  { label: 'an unresolved TODO', pattern: /\bTODO\b/g },
  { label: ARGUMENT_SLOT_LABEL, pattern: /\$ARGUMENTS/g },
]

/** Is this column inside an inline code span on this line? */
const inCodeSpan = (view: MarkdownView, line: number, column: number): boolean =>
  inRanges(view.codeSpans.get(line) ?? ([] as Range[]), column)

/** Is this position exempt — inside a fence, an HTML comment, or a code span? */
const isExempt = (view: MarkdownView, line: number, column: number): boolean =>
  inRanges(view.fenced, line) ||
  inRanges(view.htmlCommentSpans.get(line) ?? ([] as Range[]), column) ||
  inCodeSpan(view, line, column)

/**
 * The one position where `$ARGUMENTS` is meaningful rather than residue.
 *
 * [contracts/rules.md](../../../specs/005-prompt-quality-validator/contracts/rules.md) says
 * "`$ARGUMENTS` **outside the one slot where it is meaningful**", and the qualifier was
 * missing here. In a `speckit-*` skill body the token is the substitution slot the harness
 * fills at invocation — `## Context` followed by `$ARGUMENTS`, or a labelled variant such as
 * `Context for task generation: $ARGUMENTS`. Reporting it asked six skills to delete the
 * mechanism by which they receive their arguments.
 *
 * The slot is recognised structurally: `$ARGUMENTS` is the last non-whitespace token on its
 * line, and what precedes it is nothing or a `label:`. Used mid-sentence it is still
 * reported, because there it really is ambiguous with prose — and every such use in this
 * repository already sits in backticks, which was exempt anyway.
 */
const ARGUMENT_SLOT = /^\s*(?:[^:]{0,60}:\s*)?\$ARGUMENTS\s*$/

const isArgumentSlot = (label: string, line: string): boolean =>
  label === ARGUMENT_SLOT_LABEL && ARGUMENT_SLOT.test(line)

interface Hit {
  line: number
  column: number
  text: string
  label: string
}

/** Every placeholder token in the view that is not in an exempt position. */
const findHits = (view: MarkdownView): Hit[] => {
  const hits: Hit[] = []

  view.lines.forEach((text, line) => {
    for (const { label, pattern } of PATTERNS) {
      pattern.lastIndex = 0
      let match = pattern.exec(text)
      while (match !== null) {
        if (!isExempt(view, line, match.index) && !isArgumentSlot(label, text)) {
          hits.push({ line, column: match.index, text: match[0], label })
        }
        match = pattern.exec(text)
      }
    }
  })

  return hits.sort((a, b) => a.line - b.line || a.column - b.column)
}

export const placeholderResidue = defineRule(
  {
    id: 'template/placeholder-residue',
    defaultSeverity: 'error',
    statement:
      'No unresolved authoring token survives outside a code span, a fenced block or an HTML comment — bracketed template slots, clarification markers, TODO, and $ARGUMENTS. Inverted for a Spec Kit template, where the tokens must still be present.',
    rationale:
      'An agent reading a placeholder treats it as content. A next_step in this repository already checks for exactly this condition in prose, because there was no linter to hold it.',
    appliesTo: APPLIES_TO,
    dimension: 'correctness',
    scope: 'artifact',
    needs: ['view'],
  },
  (input) => {
    const artifact = requireArtifact(input)
    const view = artifact.view
    if (view === null) return []

    const hits = findHits(view)

    if (artifact.kind === 'speckit-template') {
      // Inverted: a template with no slots left has been filled in place.
      if (hits.length > 0) return []
      return [
        {
          line: 1,
          message:
            'This Spec Kit template carries no placeholder tokens, which means it has been filled in place rather than copied.',
          remediation:
            'Restore the template’s slots. A filled-in template produces one repository’s document for every future feature.',
        },
      ]
    }

    return hits.map<FindingDraft>((hit) => ({
      line: hit.line + 1,
      column: hit.column,
      message: `Contains ${hit.label}, \`${hit.text}\`, outside a code span or comment — an agent reads it as content.`,
      remediation:
        'Replace the token with real content. If it is being quoted as an example, put it in backticks — which is also how the rule catalogue quotes the tokens it detects.',
    }))
  },
)
