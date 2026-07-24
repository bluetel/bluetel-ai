#!/usr/bin/env node
/**
 * Audits cspell.json's `words` list and reports entries that appear to be
 * unused (no case-insensitive match anywhere in the repo) or duplicated.
 *
 * This script only REPORTS candidates - it does not modify cspell.json.
 * Review the output and remove words manually.
 *
 * Usage: node scripts/audit-cspell.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cspellPath = path.join(repoRoot, 'cspell.json')

const config = JSON.parse(readFileSync(cspellPath, 'utf8'))
const words = config.words ?? []

const ignoredDirs = new Set([
  'node_modules',
  'dist',
  '.next',
  '.expo',
  'android',
  'ios',
  '.git',
  '.nx',
  'build',
  'coverage',
  '.turbo',
  '.expo-shared',
])

const ignoredFiles = new Set(['cspell.json', 'pnpm-lock.yaml'])

function shouldSkipFile(name) {
  if (ignoredFiles.has(name)) return true
  if (name.endsWith('.gen.ts')) return true
  if (name.endsWith('.lock')) return true
  return false
}

/** @type {string[]} */
const files = []

function walk(dir) {
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

// Read all file contents once (lowercased) and concatenate search targets lazily per file.
const fileContents = files.map((file) => {
  try {
    const stat = statSync(file)
    if (stat.size > 5 * 1024 * 1024) return '' // skip huge files
    return readFileSync(file, 'utf8').toLowerCase()
  } catch {
    return ''
  }
})

function isUsed(word) {
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
