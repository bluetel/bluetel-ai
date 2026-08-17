/**
 * The hand-written positional scanner (research R2/R3). It answers the five
 * questions every rule asks — which line is this on, is it inside a fence, is it
 * inside an HTML comment, what heading am I under, is this token path-shaped —
 * and nothing else. It holds no judgement: every rule that reads a `MarkdownView`
 * decides for itself what a position means.
 *
 * No markdown AST library: none of the rules needs a tree, and an AST's fidelity
 * about inline positions is exactly what FR-007's line numbers depend on.
 */

/** An inclusive range — of line numbers, or of columns within one line. */
export interface Range {
  start: number
  end: number
}

export interface Heading {
  /** 0-indexed. Findings report 1-indexed. */
  line: number
  level: number
  text: string
}

export interface Link {
  line: number
  text: string
  target: string
}

/** A token that looks like a path, wherever it was found and whatever surrounds it. */
export interface PathToken {
  /** 0-indexed. */
  line: number
  /** 0-indexed column of the token's first character. */
  column: number
  raw: string
  inCodeSpan: boolean
  inFence: boolean
  inHtmlComment: boolean
  /** False when the token carries variable syntax — rule 2 of research R2. */
  literal: boolean
}

export interface MarkdownView {
  /** 0-indexed; findings report 1-indexed. */
  lines: string[]
  headings: Heading[]
  /** Inclusive line ranges of fenced code blocks, markers included. */
  fenced: Range[]
  /** Inclusive line ranges spanned by HTML comments. */
  htmlComments: Range[]
  /** Column ranges of HTML comments, per line — a comment can end mid-line. */
  htmlCommentSpans: Map<number, Range[]>
  /** Inline code spans, per line, as column ranges. */
  codeSpans: Map<number, Range[]>
  links: Link[]
  pathTokens: PathToken[]
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const INLINE_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/**
 * A token worth asking "is this a path?" about: it either contains a separator or
 * ends in something extension-shaped. Deliberately generous — narrowing this is
 * `refs/dangling-path`'s job (research R2), not the scanner's, and the rule's
 * suite needs the bare-filename case to exist in order to prove it is ignored.
 */
const PATH_CANDIDATE = /[A-Za-z0-9_@.${<*~-][A-Za-z0-9_@.${}<>*~/+-]*/g
const HAS_SEPARATOR = /\//
const EXTENSION_TAIL = /\.[A-Za-z0-9]{1,6}$/
const VARIABLE_SYNTAX = /[${}<>*]/
const SCREAMING_SNAKE_SEGMENT = /(^|\/)[A-Z][A-Z0-9]*(_[A-Z0-9]+)+(\/|$)/

/** True when `value` falls inside one of the inclusive ranges. */
export const inRanges = (ranges: readonly Range[], value: number): boolean =>
  ranges.some((range) => value >= range.start && value <= range.end)

/** True when the column falls inside one of the line's spans. */
const inSpans = (spans: Map<number, Range[]>, line: number, column: number): boolean =>
  inRanges(spans.get(line) ?? [], column)

/** Locate fenced-code line ranges. An unclosed fence runs to the end of the file. */
const scanFences = (lines: string[]): Range[] => {
  const fenced: Range[] = []
  let marker: string | null = null
  let start = 0

  // A plain loop rather than `forEach`: the state below is read again after the loop, and
  // mutating it inside a callback puts it beyond TypeScript's control-flow analysis.
  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line)
    if (marker === null) {
      if (match) {
        marker = match[1]
        start = index
      }
      continue
    }
    const closes =
      match !== null &&
      match[1][0] === marker[0] &&
      match[1].length >= marker.length &&
      match[2].trim() === ''
    if (closes) {
      fenced.push({ start, end: index })
      marker = null
    }
  }

  if (marker !== null) fenced.push({ start, end: Math.max(lines.length - 1, start) })
  return fenced
}

/**
 * Locate HTML comments as column spans per line. Comments are tracked across
 * lines because the ones that matter here are multi-line: the constitution's
 * `SYNC IMPACT REPORT` block legitimately quotes the bracketed template tokens
 * `template/placeholder-residue` detects (research R3).
 */
const scanHtmlComments = (lines: string[]): { spans: Map<number, Range[]>; ranges: Range[] } => {
  const spans = new Map<number, Range[]>()
  const ranges: Range[] = []
  let openLine: number | null = null

  const addSpan = (line: number, span: Range): void => {
    const existing = spans.get(line)
    if (existing) existing.push(span)
    else spans.set(line, [span])
  }

  // A plain loop, for the same reason `scanFences` uses one: `openLine` is read again
  // after the loop to detect an unterminated comment.
  for (const [index, line] of lines.entries()) {
    let cursor = 0
    while (cursor <= line.length) {
      if (openLine === null) {
        const open = line.indexOf('<!--', cursor)
        if (open === -1) break
        openLine = index
        const close = line.indexOf('-->', open + 4)
        if (close === -1) {
          addSpan(index, { start: open, end: line.length })
          break
        }
        addSpan(index, { start: open, end: close + 2 })
        ranges.push({ start: index, end: index })
        openLine = null
        cursor = close + 3
        continue
      }
      const close = line.indexOf('-->', cursor)
      if (close === -1) {
        addSpan(index, { start: 0, end: line.length })
        break
      }
      addSpan(index, { start: 0, end: close + 2 })
      ranges.push({ start: openLine, end: index })
      openLine = null
      cursor = close + 3
    }
  }

  if (openLine !== null) ranges.push({ start: openLine, end: Math.max(lines.length - 1, openLine) })
  return { spans, ranges }
}

/**
 * Locate inline code spans on one line as column ranges, matching CommonMark's
 * backtick-run rule: a run of N backticks is closed by the next run of exactly N.
 */
const scanCodeSpans = (line: string): Range[] => {
  const spans: Range[] = []
  let cursor = 0

  while (cursor < line.length) {
    if (line[cursor] !== '`') {
      cursor += 1
      continue
    }
    let openEnd = cursor
    while (openEnd < line.length && line[openEnd] === '`') openEnd += 1
    const runLength = openEnd - cursor

    let search = openEnd
    let closeStart = -1
    while (search < line.length) {
      if (line[search] !== '`') {
        search += 1
        continue
      }
      let closeEnd = search
      while (closeEnd < line.length && line[closeEnd] === '`') closeEnd += 1
      if (closeEnd - search === runLength) {
        closeStart = search
        search = closeEnd
        break
      }
      search = closeEnd
    }

    if (closeStart === -1) {
      cursor = openEnd
      continue
    }
    spans.push({ start: cursor, end: closeStart + runLength - 1 })
    cursor = closeStart + runLength
  }

  return spans
}

/**
 * Is the token literal — free of the variable syntax that makes it a template
 * rather than a path? Rule 2 of research R2: `$`, braces, angle brackets, globs,
 * and any SCREAMING_SNAKE segment, which is how every Spec Kit variable is written.
 */
const isLiteral = (raw: string): boolean =>
  !VARIABLE_SYNTAX.test(raw) && !SCREAMING_SNAKE_SEGMENT.test(raw)

/** Is the token shaped enough like a path to be worth a rule's opinion? */
const isPathShaped = (raw: string): boolean => HAS_SEPARATOR.test(raw) || EXTENSION_TAIL.test(raw)

/** Trim the trailing sentence punctuation that prose attaches to a path. */
const trimTrailing = (raw: string): string => raw.replace(/[.,;:!?)\]]+$/, '')

const scanPathTokens = (
  lines: string[],
  fenced: Range[],
  codeSpans: Map<number, Range[]>,
  htmlCommentSpans: Map<number, Range[]>,
  links: Link[],
): PathToken[] => {
  const tokens: PathToken[] = []
  const seen = new Set<string>()

  const push = (line: number, column: number, raw: string): void => {
    const trimmed = trimTrailing(raw)
    if (trimmed.length === 0 || !isPathShaped(trimmed)) return
    const key = `${String(line)}:${String(column)}:${trimmed}`
    if (seen.has(key)) return
    seen.add(key)
    tokens.push({
      line,
      column,
      raw: trimmed,
      inCodeSpan: inSpans(codeSpans, line, column),
      inFence: inRanges(fenced, line),
      inHtmlComment: inSpans(htmlCommentSpans, line, column),
      literal: isLiteral(trimmed),
    })
  }

  lines.forEach((line, index) => {
    PATH_CANDIDATE.lastIndex = 0
    let match = PATH_CANDIDATE.exec(line)
    while (match !== null) {
      push(index, match.index, match[0])
      match = PATH_CANDIDATE.exec(line)
    }
  })

  // Link targets are scanned separately: `[text](a/b.md)` yields the target as its
  // own token at the target's real column, so a finding points at the path rather
  // than at the link text.
  for (const link of links) {
    const line = lines[link.line] ?? ''
    const column = line.indexOf(link.target)
    push(link.line, column === -1 ? 0 : column, link.target)
  }

  return tokens.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** Scan raw markdown into the positional view every rule reads. */
export const parseMarkdown = (content: string): MarkdownView => {
  const lines = content.split('\n')
  const fenced = scanFences(lines)
  const { spans: htmlCommentSpans, ranges: htmlComments } = scanHtmlComments(lines)

  const headings: Heading[] = []
  const codeSpans = new Map<number, Range[]>()
  const links: Link[] = []

  lines.forEach((line, index) => {
    if (inRanges(fenced, index)) return

    const heading = ATX_HEADING.exec(line)
    if (heading) headings.push({ line: index, level: heading[1].length, text: heading[2] })

    const spans = scanCodeSpans(line)
    if (spans.length > 0) codeSpans.set(index, spans)

    INLINE_LINK.lastIndex = 0
    let link = INLINE_LINK.exec(line)
    while (link !== null) {
      links.push({ line: index, text: link[1], target: link[2] })
      link = INLINE_LINK.exec(line)
    }
  })

  return {
    lines,
    headings,
    fenced,
    htmlComments,
    htmlCommentSpans,
    codeSpans,
    links,
    pathTokens: scanPathTokens(lines, fenced, codeSpans, htmlCommentSpans, links),
  }
}
