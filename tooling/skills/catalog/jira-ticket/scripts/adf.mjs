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

const MARKLASSIAN_SPEC = 'marklassian@^1.2.1'

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
      ['install', '--silent', '--no-audit', '--no-fund', '--no-package-lock', MARKLASSIAN_SPEC],
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
  try {
    cached = (await import('marklassian')).markdownToAdf
    return cached
  } catch {
    // not resolvable from here — fall through to the user-level cache
  }
  const entry = join(cacheDir(), 'node_modules', 'marklassian', 'dist', 'index.js')
  const path = existsSync(entry) ? entry : installToCache()
  cached = (await import(pathToFileURL(path).href)).markdownToAdf
  return cached
}

/**
 * Strip the fenced ```markdown wrapper an LLM often adds around a whole document.
 * Left in place it becomes a codeBlock and the entire description renders as code.
 */
export function unwrapCodeFence(markdown) {
  const trimmed = markdown.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n?```$/)
  return match ? match[1] : markdown
}

/**
 * True when `markdown` still contains markdown that Jira would show verbatim.
 * Used to catch a description that was accidentally passed through as plain text.
 */
export function looksLikeMarkdown(text) {
  return /(\*\*[^*\n]+\*\*)|(^#{1,6}\s)|(^\s*[-*]\s)|(`[^`\n]+`)/m.test(text)
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
