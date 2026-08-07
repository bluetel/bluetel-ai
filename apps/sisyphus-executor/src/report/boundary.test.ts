import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * The FR-005/FR-006 boundary, asserted rather than trusted.
 *
 * The executor imports the API contract as **types only**. Types are erased,
 * so the guarantee — no resolver, no Drizzle, no `postgres` driver on the
 * instance — holds structurally right up until someone writes a value import,
 * at which point it stops holding and nothing breaks. That silence is the
 * whole risk, so this file makes the noise instead.
 *
 * Two levels, because either alone is weak:
 *
 * 1. **Source** — every `@bluetel-ai/sisyphus-api` import in the reporting and
 *    delivery directories must be `import type`, and the `/server` and `/db`
 *    subpaths must not be named at all. Precise, fast, and it says which line.
 * 2. **Bundle** — actually bundle this directory with `esbuild` and grep the
 *    output. This is the honest check: it follows whatever the module graph
 *    really is, including a value import laundered through a module that the
 *    source scan did not think to look at.
 */

const here = dirname(fileURLToPath(import.meta.url))
const scannedDirectories = [here, join(here, '..', 'delivery')]

/**
 * Production modules only. Test files are excluded because they are never
 * bundled onto an instance — and because this one has to name the forbidden
 * specifiers as literals in order to look for them.
 */
const sourceFiles = (): { readonly path: string; readonly text: string }[] =>
  scannedDirectories.flatMap((directory) =>
    readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({
        path: join(directory, name),
        text: readFileSync(join(directory, name), 'utf8'),
      })),
  )

/** Matches an import statement naming the API package, type-only or not. */
const API_IMPORT =
  /import\s+(?<typeOnly>type\s+)?[^'"]*from\s+'(?<specifier>@bluetel-ai\/sisyphus-api[^']*)'/g

interface ApiImport {
  readonly typeOnly: boolean
  readonly specifier: string
}

const apiImportsIn = (text: string): ApiImport[] =>
  [...text.matchAll(API_IMPORT)].map((match) => ({
    typeOnly: match.groups?.typeOnly !== undefined,
    specifier: match.groups?.specifier ?? '',
  }))

describe('the API contract boundary', () => {
  it('imports the contract as types only', () => {
    const offenders: string[] = []

    for (const file of sourceFiles()) {
      for (const found of apiImportsIn(file.text)) {
        if (!found.typeOnly) {
          offenders.push(`${file.path}: value import of ${found.specifier}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('never names the server or database subpaths', () => {
    const offenders = sourceFiles()
      .filter(
        (file) =>
          file.text.includes('@bluetel-ai/sisyphus-api/server') ||
          file.text.includes('@bluetel-ai/sisyphus-api/db'),
      )
      .map((file) => file.path)

    expect(offenders).toEqual([])
  })

  it('reaches the contract only through the /client subpath', () => {
    const specifiers = sourceFiles().flatMap((file) =>
      apiImportsIn(file.text).map((found) => found.specifier),
    )

    expect(specifiers.length).toBeGreaterThan(0)
    expect([...new Set(specifiers)]).toEqual(['@bluetel-ai/sisyphus-api/client'])
  })

  it('produces a bundle containing no database driver or ORM', async () => {
    const bundled = await build({
      entryPoints: [join(here, 'index.ts'), join(here, '..', 'delivery', 'index.ts')],
      bundle: true,
      write: false,
      // Required by esbuild for multiple entry points; nothing is written.
      outdir: join(here, '..', '..', 'dist', 'boundary-check'),
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'silent',
    })

    const output = bundled.outputFiles.map((file) => file.text).join('\n')

    expect(output.length).toBeGreaterThan(0)

    for (const forbidden of ['drizzle-orm', 'postgres.js', 'pg_catalog', 'PgTable', 'pgTable']) {
      expect(output).not.toContain(forbidden)
    }
  }, 60_000)
})
