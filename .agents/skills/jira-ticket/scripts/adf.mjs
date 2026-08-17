// Markdown -> Atlassian Document Format (ADF).
//
// Why this exists: `acli jira workitem create --description` sends the string as
// plain text, so a markdown description lands in Jira as literal `**bold**` and
// `## heading` characters instead of formatting. The REST API accepts a real ADF
// document for `fields.description`, so we convert first and POST that instead.
//
// Conversion is delegated to marklassian (MIT, https://github.com/jamsinclair/marklassian)
// rather than hand-rolled: ADF has a lot of surface area and marklassian already
// tracks it. It is resolved at runtime rather than vendored, because this script is
// copied verbatim into target repos that may not be Node projects at all:
//
//   1. a normal `import` — hits the workspace install when one exists;
//   2. otherwise a one-off `npm install` into a user-level cache dir.
//
// Only step 2 needs the network, and only the first time on a given machine.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Pinned exactly, not a caret range: this install has no lockfile to record an
// integrity hash against, so a floating range would let the resolved bytes change
// between machines and over time with nothing to compare them to.
const MARKLASSIAN_SPEC = 'marklassian@1.2.1'

function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'bluetel-skills', 'adf')
}

function installToCache() {
  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  // A package.json here stops npm walking up and installing into the host repo.
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'bluetel-skills-adf', private: true, type: 'module' }, null, 2)}\n`,
  )
  try {
    execFileSync(
      'npm',
      [
        'install',
        '--silent',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        // marklassian and marked are plain JS with nothing to build, so no lifecycle
        // script needs to run — and this install is unattended, triggered as a side
        // effect of creating a ticket. Don't hand a postinstall the developer's shell.
        '--ignore-scripts',
        MARKLASSIAN_SPEC,
      ],
      {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
  } catch (cause) {
    throw new Error(
      `could not install ${MARKLASSIAN_SPEC} into ${dir}.\n` +
        'It converts the markdown description into ADF, without which Jira renders the\n' +
        'description as literal markdown. Check network access and that `npm` is on PATH,\n' +
        `or install it into this repo with: npm install --save-dev ${MARKLASSIAN_SPEC}`,
      { cause },
    )
  }
  return join(dir, 'node_modules', 'marklassian', 'dist', 'index.js')
}

let cached
/** Resolve marklassian's `markdownToAdf`, installing it on first use if needed. */
export async function loadConverter() {
  if (cached) return cached

  // A wrong major, or a stub shadowing the real package in the host repo, resolves
  // fine but has no markdownToAdf. Check before caching, so this falls through to
  // the known-good cache install instead of failing later as "not a function".
  try {
    const { markdownToAdf } = await import('marklassian')
    if (typeof markdownToAdf === 'function') {
      cached = markdownToAdf
      return cached
    }
  } catch {
    // not resolvable from here — fall through to the user-level cache
  }

  const entry = join(cacheDir(), 'node_modules', 'marklassian', 'dist', 'index.js')
  const path = existsSync(entry) ? entry : installToCache()
  const { markdownToAdf } = await import(pathToFileURL(path).href)
  if (typeof markdownToAdf !== 'function') {
    throw new Error(
      `${path} does not export markdownToAdf — the cached install looks incomplete.\n` +
        `Delete ${cacheDir()} and re-run to reinstall it.`,
    )
  }
  cached = markdownToAdf
  return cached
}

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
export async function markdownToAdfDocument(markdown) {
  const source = unwrapCodeFence(markdown)
  if (source.trim() === '') throw new Error('description is empty')
  const convert = await loadConverter()
  const doc = convert(source)
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) {
    throw new Error('conversion did not produce an ADF doc node')
  }
  return doc
}
