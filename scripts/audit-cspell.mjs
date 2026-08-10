#!/usr/bin/env node
/**
 * Audits cspell.json's `words` list and reports entries that appear to be
 * unused (no case-insensitive match anywhere in the repo's own sources) or
 * duplicated.
 *
 * This script only REPORTS candidates - it does not modify cspell.json.
 * Review the output and remove words manually.
 *
 * Usage: node scripts/audit-cspell.mjs   (or: pnpm audit:cspell)
 */
/* global console */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cspellPath = path.join(repoRoot, 'cspell.json')

/**
 * cspell.json is JSONC, not JSON: it carries `//` comments explaining the
 * en-GB/en-US pairing and several of the word entries. `JSON.parse` throws on
 * the first one, which is why this script silently never ran between the day
 * that comment was added and 002/T245.
 *
 * The strip is done by hand rather than with `jsonc-parser` deliberately.
 * `nodeLinker: hoisted` means that package is resolvable from the root even
 * though nothing declares it, so importing it would be a phantom dependency;
 * declaring it properly would then be reported as an unused devDependency by
 * `pnpm knip`, because the root workspace's `project` glob only covers `.ts`
 * and `.js` under `scripts/`, not `.mjs`. A repo script that audits dictionary
 * hygiene should not cost the repo a dependency to run.
 *
 * @param {string} text
 * @returns {unknown}
 */
const parseJsonc = (text) => {
  let out = ''
  let inString = false
  let escaped = false
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      i++
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      i++
      continue
    }

    // Line comment: drop to end of line, keeping the newline for line numbers.
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    // Block comment: drop through the closing delimiter.
    if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }

    out += char
    i++
  }

  // Trailing commas are legal in JSONC and cspell accepts them.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const config = parseJsonc(readFileSync(cspellPath, 'utf8'))
const words = config.words ?? []

/**
 * Kept in step with .gitignore. A word that appears only in build output is
 * dead as far as the dictionary is concerned - the artefact is regenerated
 * from sources that no longer contain it - so counting those hits would keep
 * stale entries alive indefinitely.
 */
const ignoredDirs = new Set([
  'node_modules',
  'dist',
  '.next',
  'out',
  '.expo',
  '.expo-shared',
  '.sst',
  'android',
  'ios',
  '.git',
  '.nx',
  'build',
  'coverage',
  '.turbo',
])

const ignoredFiles = new Set(['cspell.json', 'pnpm-lock.yaml'])

/** Build artefacts that are written beside sources rather than into dist/. */
const ignoredSuffixes = ['.tsbuildinfo', '.gen.ts', '.lock']

/**
 * @param {string} name
 * @returns {boolean}
 */
const shouldSkipFile = (name) => {
  if (ignoredFiles.has(name)) return true
  return ignoredSuffixes.some((suffix) => name.endsWith(suffix))
}

/** @type {string[]} */
const files = []

/** @param {string} dir */
const walk = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue
      walk(path.join(dir, entry.name))
    } else if (entry.isFile()) {
      if (shouldSkipFile(entry.name)) continue
      files.push(path.join(dir, entry.name))
    }
  }
}

walk(repoRoot)

console.log(`Scanning ${files.length} files for ${words.length} words...\n`)

const fileContents = files.map((file) => {
  try {
    const stat = statSync(file)
    if (stat.size > 5 * 1024 * 1024) return '' // skip huge files
    return readFileSync(file, 'utf8').toLowerCase()
  } catch {
    return ''
  }
})

/**
 * Substring rather than whole-word matching, on purpose: cspell splits
 * identifiers on case boundaries, so the entry `upsert` is genuinely earning
 * its place when the only occurrence in the repo is inside `upsertUser`. A
 * word-boundary regex would report every such entry as dead.
 *
 * @param {string} word
 * @returns {boolean}
 */
const isUsed = (word) => {
  const needle = word.toLowerCase()
  return fileContents.some((content) => content.includes(needle))
}

const seen = new Map()
const duplicates = []
for (const word of words) {
  const key = word.toLowerCase()
  if (seen.has(key)) {
    duplicates.push({ word, duplicateOf: seen.get(key) })
  } else {
    seen.set(key, word)
  }
}

const unused = words.filter((word) => !isUsed(word))

if (duplicates.length) {
  console.log(`Duplicate entries (${duplicates.length}):`)
  for (const { word, duplicateOf } of duplicates) {
    console.log(`  - "${word}" (duplicate of "${duplicateOf}")`)
  }
  console.log()
}

if (unused.length) {
  console.log(`Unused words - no matches found in repo (${unused.length}):`)
  for (const word of unused) {
    console.log(`  - "${word}"`)
  }
  console.log()
} else {
  console.log('No unused words found.\n')
}

console.log('Review the above and remove entries manually from cspell.json.')
