/* eslint-disable -- Skill payload, not this repo's source. skills.sh copies this file verbatim
   into target repos and content-hashes the copy against the catalog, so any tool that rewrites
   it there reports the skill as locally-modified on the next update — and a formatter that
   "tidies" a hand-written parser is exactly the kind of rewrite that goes unnoticed. The
   directives below say the same thing to the other toolchains a target repo might run. */
// oxlint-disable
/** biome-ignore-all lint: skill payload copied verbatim — see the eslint-disable above */
/** biome-ignore-all format: skill payload copied verbatim — see the eslint-disable above */
// oxfmt-ignore
// prettier-ignore
//
// Block markdown -> ADF block nodes: paragraphs, headings, lists, code blocks, quotes,
// tables and rules. adf-inline.mjs handles what goes inside them.
//
// Line-oriented by design: every block here is recognised from the start of a line, which is
// what makes the parser small enough to read. Anything unrecognised falls through to a
// paragraph, so an unsupported construct arrives in Jira as the text the author typed rather
// than as a wrong structure.

import { inlineNodes } from './adf-inline.mjs'

/** ```lang / ~~~lang, up to three spaces of indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/
/** # Heading, optionally closed with trailing #s. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
/** --- / *** / ___ — three or more, optionally spaced. */
const RULE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/
/** > quoted, with the one optional space after the marker. */
const QUOTE = /^ {0,3}>\s?(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/

const indentOf = (line) => line.length - line.trimStart().length

/** A paragraph node, or null when the text held no content — an empty paragraph is a blank
 * line in Jira, so emitting one for every stray marker would space the ticket out oddly. */
function paragraph(text) {
  const content = inlineNodes(text)
  return content.length > 0 ? { type: 'paragraph', content } : null
}

/** The head of a list item: its indent, its marker width, and the text after the marker. */
function matchItem(line) {
  const bullet = BULLET.exec(line)
  if (bullet) {
    return {
      indent: bullet[1].length,
      ordered: false,
      start: 1,
      text: bullet[2],
      width: bullet[0].length - bullet[2].length,
    }
  }
  const ordered = ORDERED.exec(line)
  if (ordered) {
    return {
      indent: ordered[1].length,
      ordered: true,
      start: Number(ordered[2]),
      text: ordered[3],
      width: ordered[0].length - ordered[3].length,
    }
  }
  return null
}

/** True when a line begins a block, and so cannot be swallowed into the paragraph above it. */
function startsBlock(line) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    matchItem(line) !== null
  )
}

function readFence(lines, start, opening) {
  const [, marker, language] = opening
  const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}\\s*$`)
  const strip = indentOf(lines[start])
  const body = []
  let i = start + 1
  while (i < lines.length && !closing.test(lines[i])) {
    body.push(lines[i].slice(Math.min(strip, indentOf(lines[i]))))
    i += 1
  }
  // An unclosed fence still ends the block: the alternative is silently dropping everything
  // after a typo'd fence, which is the failure mode this whole conversion exists to avoid.
  const node = { type: 'codeBlock' }
  if (language !== '') node.attrs = { language }
  node.content = body.length > 0 ? [{ type: 'text', text: body.join('\n') }] : []
  return { node, next: i < lines.length ? i + 1 : i }
}

function readQuote(lines, start) {
  const inner = []
  let i = start
  while (i < lines.length) {
    const quoted = QUOTE.exec(lines[i])
    if (quoted) {
      inner.push(quoted[1])
      i += 1
      continue
    }
    // A quote continues over an unmarked prose line (markdown's "lazy continuation"), but
    // stops at a blank line or at anything that opens a block of its own.
    if (lines[i].trim() === '' || startsBlock(lines[i])) break
    inner.push(lines[i].trimStart())
    i += 1
  }
  const content = blockNodes(inner)
  return {
    node: {
      type: 'blockquote',
      content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }],
    },
    next: i,
  }
}

/**
 * One list and everything nested inside it.
 *
 * Items are collected as raw lines, dedented by the marker width, then parsed as blocks —
 * so a nested list, a code block or a second paragraph inside an item all work without this
 * function knowing anything about them.
 */
function readList(lines, start) {
  const first = matchItem(lines[start])
  const { ordered, indent } = first
  const items = []
  let i = start

  while (i < lines.length) {
    const item = matchItem(lines[i])
    if (item === null || item.indent !== indent || item.ordered !== ordered) break

    const body = [item.text]
    i += 1

    while (i < lines.length) {
      const line = lines[i]

      if (line.trim() === '') {
        const next = lines[i + 1]
        // A blank line ends the list unless the item continues under it — two blanks, or a
        // line dedented out of the item, and this list is over.
        if (next === undefined || next.trim() === '') break
        const following = matchItem(next)
        if (following !== null && following.indent <= indent) break
        if (following === null && indentOf(next) < item.width) break
        body.push('')
        i += 1
        continue
      }

      const nested = matchItem(line)
      if (nested !== null && nested.indent <= indent) break
      if (nested !== null || indentOf(line) >= item.width) {
        body.push(line.slice(Math.min(item.width, indentOf(line))))
        i += 1
        continue
      }
      if (startsBlock(line)) break
      // A wrapped line: the rest of the item's sentence, at any indent.
      body.push(line.trimStart())
      i += 1
    }

    const content = blockNodes(body)
    items.push({
      type: 'listItem',
      content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }],
    })
  }

  const node = { type: ordered ? 'orderedList' : 'bulletList' }
  // Only when it is not 1: `attrs.order` is noise on the common case, and Jira defaults it.
  if (ordered && first.start !== 1) node.attrs = { order: first.start }
  node.content = items
  return { node, next: i }
}

/** Cells of a pipe-table row, honouring `\|` inside a cell. */
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cell = ''
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      cell += '|'
      i += 1
      continue
    }
    if (inner[i] === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += inner[i]
  }
  cells.push(cell.trim())
  return cells
}

/** The `| --- | :-- |` line that makes the row above it a table header. */
function isDivider(line) {
  if (!line.includes('|') || !line.includes('-')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function tableCell(text, header) {
  return {
    type: header ? 'tableHeader' : 'tableCell',
    attrs: {},
    content: [{ type: 'paragraph', content: inlineNodes(text) }],
  }
}

/**
 * A GFM pipe table, or null.
 *
 * Requires the divider row, like GFM does, which is also what keeps a paragraph that merely
 * contains a `|` from being read as a one-row table.
 */
function readTable(lines, start) {
  const divider = lines[start + 1]
  if (!lines[start].includes('|') || divider === undefined || !isDivider(divider)) return null

  const rows = [splitRow(lines[start])]
  let i = start + 2
  while (
    i < lines.length &&
    lines[i].trim() !== '' &&
    lines[i].includes('|') &&
    !startsBlock(lines[i])
  ) {
    rows.push(splitRow(lines[i]))
    i += 1
  }

  return {
    node: {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: rows.map((cells, row) => ({
        type: 'tableRow',
        content: cells.map((cell) => tableCell(cell, row === 0)),
      })),
    },
    next: i,
  }
}

function readParagraph(lines, start) {
  const body = []
  let i = start
  while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
    // trimStart, not trim: two trailing spaces are markdown's explicit line break, and
    // trimming them here would silently delete every hard break in the description.
    body.push(lines[i].trimStart())
    i += 1
  }
  // Joined with newlines, not spaces: adf-inline.mjs decides whether each break is a wrap
  // (a space) or a deliberate hard break (two trailing spaces).
  return { node: paragraph(body.join('\n').replace(/\s+$/, '')), next: i }
}

/** Convert an array of markdown lines into ADF block nodes. */
export function blockNodes(lines) {
  const nodes = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const { node, next } = readFence(lines, i, fence)
      nodes.push(node)
      i = next
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      nodes.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineNodes(heading[2]),
      })
      i += 1
      continue
    }

    // Before the list check: `- - -` is a rule, not three nested bullets.
    if (RULE.test(line)) {
      nodes.push({ type: 'rule' })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const { node, next } = readQuote(lines, i)
      nodes.push(node)
      i = next
      continue
    }

    if (matchItem(line) !== null) {
      const { node, next } = readList(lines, i)
      nodes.push(node)
      i = next
      continue
    }

    const table = readTable(lines, i)
    if (table) {
      nodes.push(table.node)
      i = table.next
      continue
    }

    const { node, next } = readParagraph(lines, i)
    if (node) nodes.push(node)
    i = next
  }

  return nodes
}
