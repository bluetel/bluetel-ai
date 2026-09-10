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
// Markdown -> Atlassian Document Format (ADF).
//
// Why this exists: `acli jira workitem create --description` sends the string as plain text,
// so a markdown description lands in Jira as literal `**bold**` and `## heading` characters
// instead of formatting. The REST API accepts a real ADF document for `fields.description`,
// so we convert first and POST that instead.
//
// The conversion is implemented here, in three dependency-free files:
//
//   adf.mjs         this file — the entry point, plus the two guards below
//   adf-blocks.mjs  paragraphs, headings, lists, code blocks, quotes, tables, rules
//   adf-inline.mjs  strong, em, strike, code, links
//
// It used to delegate to marklassian, resolved at runtime and `npm install`ed into a
// user-level cache when the workspace could not resolve it. That is gone: skills.sh copies
// this directory verbatim into repos that may not be Node projects at all, so the fallback
// meant the first ticket on a machine needed npm and network access, and then ran code that
// no lockfile in the consuming repo pinned. A ticket description uses a small and stable
// subset of markdown — the templates in references/ticket-types.md are the whole of it — and
// owning that subset outright is cheaper than owning a runtime installer for it.

import { blockNodes } from './adf-blocks.mjs'

const FENCE = /^```/
const WRAPPER_OPEN = /^```(?:markdown|md)?\s*$/
const FENCE_CLOSE = /^```\s*$/

/**
 * True when the text contains markdown Jira would otherwise show verbatim. Used to
 * tell a whole-document wrapper apart from a description that is deliberately a
 * single code block — see unwrapCodeFence.
 */
export function looksLikeMarkdown(text) {
  return /(\*\*[^*\n]+\*\*)|(^#{1,6}\s)|(^\s*[-*]\s)|(`[^`\n]+`)/m.test(text)
}

/**
 * Strip the fenced ```markdown wrapper an LLM often adds around a whole document.
 * Left in place it becomes a codeBlock and the entire description renders as code.
 *
 * Only unwraps when the document is *exactly* one fenced block. A description that
 * merely starts and ends with code blocks — a log excerpt at the top, a command at
 * the bottom — must be left alone: stripping those two lines would leave the inner
 * fences unbalanced and mangle the render, which is the very failure this whole
 * script exists to prevent.
 *
 * An untagged ``` opener is ambiguous: it is equally a lazy wrapper or a genuine
 * untagged code block that happens to be the entire description. Those are told
 * apart by content — prose markup inside means it was a wrapper.
 */
export function unwrapCodeFence(markdown) {
  const lines = markdown.trim().split(/\r?\n/)
  if (lines.length < 2) return markdown
  if (!WRAPPER_OPEN.test(lines[0])) return markdown
  if (!FENCE_CLOSE.test(lines[lines.length - 1])) return markdown
  // More than the opening and closing pair means those are real code blocks.
  if (lines.filter((line) => FENCE.test(line)).length !== 2) return markdown

  const body = lines.slice(1, -1).join('\n')
  const tagged = /^```(?:markdown|md)\s*$/.test(lines[0])
  if (!tagged && !looksLikeMarkdown(body)) return markdown
  return body
}

/** Convert a markdown description into an ADF document ready for `fields.description`. */
export function markdownToAdfDocument(markdown) {
  const source = unwrapCodeFence(markdown)
  if (source.trim() === '') throw new Error('description is empty')

  const content = blockNodes(source.replace(/\r\n?/g, '\n').split('\n'))
  // Not reachable from a non-empty source with the current grammar — every line either opens
  // a block or becomes a paragraph. Checked anyway: a doc with no content is the one payload
  // Jira accepts while silently publishing a blank description.
  if (content.length === 0) throw new Error('description produced no content')

  return { version: 1, type: 'doc', content }
}
