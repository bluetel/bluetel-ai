/**
 * Reasoned inline suppressions (FR-009) and the bookkeeping that makes them drain
 * (FR-010).
 *
 * Only next-line scope exists. File-wide suppression is deliberately absent: "this
 * whole file is exempt" is a decision that belongs in the central config where a
 * reviewer sees it, not in the file being exempted.
 *
 * `rule` is a plain string rather than a `RuleId` on purpose — it is untrusted text
 * scraped out of a comment, and whether it names a rule that exists is the
 * evaluator's question to answer against the registry, not this parser's to assume.
 */

export interface Suppression {
  /** As written in the comment. Not yet known to name a real rule. */
  rule: string
  /** 1-indexed line the suppression applies to — the line after the marker. */
  targetLine: number
  /** 1-indexed line the marker itself is on. */
  markerLine: number
  /** Empty when the author gave none, which is itself a finding (FR-009). */
  reason: string
  /** Set during evaluation. A suppression matching nothing is reported stale (FR-010). */
  used: boolean
}

const DIRECTIVE = 'prompt-lint-disable-next-line'

/** `<!-- prompt-lint-disable-next-line <rule> — <reason> -->` */
const MARKDOWN_MARKER = new RegExp(`<!--\\s*${DIRECTIVE}\\s+([^\\s]+)([^]*?)-->`)
/** `# prompt-lint-disable-next-line <rule> — <reason>` */
const META_MARKER = new RegExp(`^\\s*#\\s*${DIRECTIVE}\\s+([^\\s]+)(.*)$`)

/**
 * Strip the separator between the rule id and the reason. The documented form uses
 * an em dash; an en dash, a hyphen run and a colon are accepted too, because
 * rejecting a reason over its punctuation would report an author who supplied one as
 * having supplied none — the opposite of what FR-009 is for.
 */
const SEPARATOR = /^\s*(?:[—–]|-{1,2}|:)\s*/

const readReason = (tail: string): string => {
  const separated = SEPARATOR.exec(tail)
  if (!separated) return ''
  return tail.slice(separated[0].length).trim()
}

/** Parse every suppression marker in a file, per its comment syntax. */
export const parseSuppressions = (
  content: string,
  format: 'markdown' | 'skill-meta',
): Suppression[] => {
  const marker = format === 'markdown' ? MARKDOWN_MARKER : META_MARKER
  const suppressions: Suppression[] = []

  content.split('\n').forEach((raw, index) => {
    const match = marker.exec(raw)
    if (!match) return
    suppressions.push({
      rule: match[1],
      markerLine: index + 1,
      targetLine: index + 2,
      reason: readReason(match[2]),
      used: false,
    })
  })

  return suppressions
}

/**
 * Does a suppression cover this finding? Matching is on rule id and target line, so a
 * marker suppresses the one line it sits above and nothing else.
 */
export const suppresses = (suppression: Suppression, rule: string, line: number): boolean =>
  suppression.rule === rule && suppression.targetLine === line
