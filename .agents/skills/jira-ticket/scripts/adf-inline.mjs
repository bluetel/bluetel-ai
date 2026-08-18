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
// Inline markdown -> ADF text nodes: the marks (strong, em, strike, code, link).
//
// Half of the markdown -> ADF conversion described in adf.mjs; adf-blocks.mjs is the other.
// They are separate files because they are separate problems — blocks are line-oriented,
// inline is a character scan — and each is worth reading on its own.
//
// This is deliberately a subset of CommonMark: the constructs the ticket templates use, plus
// what people actually type into a description. What is *not* supported matters as much as
// what is, because anything unrecognised has to degrade to the literal characters rather than
// to something structurally wrong. Raw HTML, reference links, footnotes and the more exotic
// emphasis flanking rules all fall through to plain text.

/** Punctuation a backslash may escape. CommonMark allows all ASCII punctuation; this is the
 * subset that means anything to this parser, so `\<` stays `\<` and only `\*` loses its slash. */
const ESCAPABLE = '\\`*_~[]()<>#+-.!|{}'

/** A run of backticks, closed by a run of the same length: `code`, ``a `b` c``. */
const CODE_SPAN = /^(`+)([\s\S]*?)\1(?!`)/

/** `[label](href)`, `[label](href "title")`, and the `!` image form. */
const LINK = /^(!?)\[((?:\\.|[^[\]\\])*)\]\(\s*([^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/

/** `<https://example.com>` — only for schemes we would linkify bare anyway. */
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/

/** A bare URL. Kept to http(s) on purpose: `www.` and bare hostnames catch prose like
 * "see foo.bar below", and a wrong link is worse than an unlinked URL. */
const BARE_URL = /^https?:\/\/[^\s<>[\]{}"'`]+/

/** Two or more trailing spaces, or a trailing backslash, before a newline. */
const HARD_BREAK = /^(?: {2,}|\\)\n/

/** A single newline inside a paragraph — a soft break, which joins. */
const SOFT_BREAK = /^ *\n */

/** Letters and digits in any script: `_` between two of these is intraword, not emphasis. */
const WORD = /[\p{L}\p{N}]/u

/** Longest delimiter first: `**` must be tried before `*`, or every bold run reads as two
 * empty italics. `_`/`__` are the same delimiters with the intraword guard below. */
const EMPHASIS = [
  { delimiter: '**', mark: 'strong' },
  { delimiter: '__', mark: 'strong' },
  { delimiter: '~~', mark: 'strike' },
  { delimiter: '*', mark: 'em' },
  { delimiter: '_', mark: 'em' },
]

function textNode(text, marks) {
  const node = { type: 'text', text }
  if (marks.length > 0) node.marks = marks
  return node
}

/** Add a mark, keeping the array flat and free of duplicates. Marks nest by accumulating
 * here rather than by nesting nodes: ADF has no inline containers, only marked text runs. */
function withMark(marks, mark) {
  return marks.some((existing) => existing.type === mark.type) ? marks : [...marks, mark]
}

/**
 * Index of the closing `delimiter` in `text`, or -1.
 *
 * Skips escaped characters, and — for the single-character delimiters — skips a doubled run,
 * so the `*` in `*a **b** c*` closes at the right place rather than inside the bold run.
 */
function findClosing(text, delimiter) {
  for (let i = delimiter.length; i <= text.length - delimiter.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (!text.startsWith(delimiter, i)) continue
    if (delimiter.length === 1 && text.startsWith(delimiter + delimiter, i)) {
      i += 1
      continue
    }
    return i
  }
  return -1
}

/**
 * Emphasis starting at the head of `rest`, or null. `previous` is the character before it.
 *
 * Two guards, both there to stop ordinary prose turning into italics:
 *
 * - **Flanking.** A delimiter run next to whitespace neither opens nor closes, so `3 * 4 * 5`
 *   and `a - b -- c` stay arithmetic and dashes.
 * - **Intraword `_`.** `_` inside a word is a literal underscore, so `customfield_12042` and
 *   `has_author_page` survive — identifiers like those are all over these tickets.
 */
function emphasisAt(rest, previous) {
  for (const { delimiter, mark } of EMPHASIS) {
    if (!rest.startsWith(delimiter)) continue
    if (delimiter[0] === '_' && WORD.test(previous)) continue

    const end = findClosing(rest, delimiter)
    if (end < 0) continue

    const inner = rest.slice(delimiter.length, end)
    if (inner === '' || /^\s/.test(inner) || /\s$/.test(inner)) continue

    const after = rest.slice(end + delimiter.length, end + delimiter.length + 1)
    if (delimiter[0] === '_' && WORD.test(after)) continue

    return { inner, mark, length: end + delimiter.length }
  }
  return null
}

/** CommonMark's code-span trimming: newlines become spaces, and one space is stripped from
 * each end when both are there (which is how you write a span that starts with a backtick). */
function codeText(raw) {
  const collapsed = raw.replace(/\n/g, ' ')
  if (collapsed.length > 2 && collapsed.startsWith(' ') && collapsed.endsWith(' ')) {
    return collapsed.slice(1, -1)
  }
  return collapsed
}

/** Trailing punctuation that belongs to the sentence, not to the URL it follows. A closing
 * bracket is only trimmed when the URL has no matching opener — Confluence links contain them. */
function trimUrlTail(url) {
  let end = url.length
  while (end > 0) {
    const char = url[end - 1]
    if ('.,;:!?'.includes(char)) {
      end -= 1
      continue
    }
    const head = url.slice(0, end)
    if (char === ')' && (head.match(/\(/g) ?? []).length < (head.match(/\)/g) ?? []).length) {
      end -= 1
      continue
    }
    break
  }
  return url.slice(0, end)
}

/**
 * Convert inline markdown into ADF inline nodes.
 *
 * `marks` is the set inherited from an enclosing construct — how a link label keeps its bold,
 * and how recursion carries state instead of the caller having to merge afterwards.
 */
export function inlineNodes(source, marks = []) {
  const nodes = []
  let pending = ''
  let i = 0

  const flush = () => {
    if (pending !== '') {
      nodes.push(textNode(pending, marks))
      pending = ''
    }
  }

  while (i < source.length) {
    const rest = source.slice(i)
    const char = source[i]

    if (char === '\\' && ESCAPABLE.includes(source[i + 1] ?? '')) {
      pending += source[i + 1]
      i += 2
      continue
    }

    if (char === '\n' || char === ' ' || char === '\\') {
      const hard = HARD_BREAK.exec(rest)
      if (hard) {
        flush()
        nodes.push({ type: 'hardBreak' })
        i += hard[0].length
        continue
      }
      const soft = SOFT_BREAK.exec(rest)
      if (soft) {
        // A line break the author did not ask twice for is a wrap, not a break: joining with
        // a space is what stops hand-wrapped prose arriving in Jira as ragged short lines.
        pending += ' '
        i += soft[0].length
        continue
      }
    }

    if (char === '`') {
      const code = CODE_SPAN.exec(rest)
      if (code) {
        flush()
        nodes.push(textNode(codeText(code[2]), withMark(marks, { type: 'code' })))
        i += code[0].length
        continue
      }
    }

    if (char === '[' || (char === '!' && source[i + 1] === '[')) {
      const link = LINK.exec(rest)
      if (link) {
        const [matched, bang, label, href] = link
        flush()
        // ADF images are `media` nodes keyed by an upload id, so an external image URL cannot
        // become one. A link labelled with the alt text is the honest degradation.
        const marked = withMark(marks, { type: 'link', attrs: { href } })
        const inner = label === '' ? href : label
        nodes.push(...(bang === '!' ? [textNode(inner, marked)] : inlineNodes(inner, marked)))
        i += matched.length
        continue
      }
    }

    if (char === '<') {
      const auto = AUTOLINK.exec(rest)
      if (auto) {
        flush()
        nodes.push(textNode(auto[1], withMark(marks, { type: 'link', attrs: { href: auto[1] } })))
        i += auto[0].length
        continue
      }
    }

    // Only at a word boundary, so the tail of a URL already inside a link label is not
    // linkified a second time.
    if (char === 'h' && !WORD.test(source[i - 1] ?? '')) {
      const bare = BARE_URL.exec(rest)
      if (bare) {
        const href = trimUrlTail(bare[0])
        flush()
        nodes.push(textNode(href, withMark(marks, { type: 'link', attrs: { href } })))
        i += href.length
        continue
      }
    }

    if (char === '*' || char === '_' || char === '~') {
      const emphasis = emphasisAt(rest, source[i - 1] ?? '')
      if (emphasis) {
        flush()
        nodes.push(...inlineNodes(emphasis.inner, withMark(marks, { type: emphasis.mark })))
        i += emphasis.length
        continue
      }
    }

    pending += char
    i += 1
  }

  flush()
  return nodes
}
