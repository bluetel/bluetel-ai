import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * **There is one definition of a machine credential, and this test is what keeps it that way.**
 *
 * This application used to carry a near-line-for-line copy of
 * `apps/sisyphus-control-plane/src/credentials/{claims,verify}.ts`, written because the panel
 * cannot import the control plane. Both copies were pinned to their literals by their own tests
 * and each carried a comment naming the other. That is not a mitigation: two verifiers that can
 * disagree about what a valid credential *is* is a security defect waiting for a divergent edit,
 * and a mismatch is silent until an executor instance is running — every machine request fails
 * closed, at the worst possible moment to find out.
 *
 * Both hosts now import `@bluetel-ai/sisyphus-api/server`. A comment cannot stop someone
 * re-introducing a local copy — "it is only one constant, and the import is awkward here" is
 * exactly how the first copy came to be written — so this scans the application's own source and
 * fails if any of the vocabulary reappears in it.
 *
 * Test files are exempt, and have to be: this one names the forbidden strings in order to look for
 * them, and `jose-binding.test.ts` legitimately signs tokens with them.
 */

const here = dirname(fileURLToPath(import.meta.url))
const applicationSource = join(here, '..', '..')

interface SourceFile {
  readonly path: string
  readonly text: string
}

const sourceFiles = (): SourceFile[] =>
  readdirSync(applicationSource, { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
    )
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return {
        path: relative(applicationSource, path).split(sep).join('/'),
        text: readFileSync(path, 'utf8'),
      }
    })

/**
 * Every value a second copy would have to restate.
 *
 * The subject prefixes are matched as **quoted** literals: `workflow:<id>` appears in prose and
 * forbidding the bare string would forbid explaining the format.
 */
const FORBIDDEN_LITERALS = [
  "'sisyphus-machine-surface'",
  '"sisyphus-machine-surface"',
  "'sisyphus-control-plane'",
  '"sisyphus-control-plane"',
  "'HS256'",
  '"HS256"',
  "'workflow:'",
  '"workflow:"',
  "'validation:'",
  '"validation:"',
  '15 * 60 * 1000',
  '12 * 60 * 60 * 1000',
]

/**
 * Where this application is allowed to reach for a JOSE implementation.
 *
 * One file, and it contains one assignment. Verification policy is the shared module's; a second
 * `jose` import here would be somewhere for a second opinion about it to grow.
 */
const JOSE_IMPORT_ALLOWED_IN = ['server/machine-credential/jose-binding.ts']

describe('the machine-credential vocabulary is defined once, in the API package', () => {
  it('finds source to scan at all, so a broken glob cannot pass silently', () => {
    expect(sourceFiles().length).toBeGreaterThan(10)
  })

  it('restates none of it in this application', () => {
    const offenders = sourceFiles().flatMap((file) =>
      FORBIDDEN_LITERALS.filter((literal) => file.text.includes(literal)).map(
        (literal) => `${file.path}: restates ${literal}`,
      ),
    )

    expect(offenders).toStrictEqual([])
  })

  it('reaches for a JOSE implementation in exactly one place', () => {
    const importers = sourceFiles()
      .filter((file) => file.text.includes("from 'jose'"))
      .map((file) => file.path)

    expect(importers).toStrictEqual(JOSE_IMPORT_ALLOWED_IN)
  })

  it('has no local module named for the vocabulary or the verifier', () => {
    // `machine-credential/claims.ts` and `machine-credential/verify.ts` were the copies. Their
    // absence is the fix; their reappearance under the same names would be the regression.
    const paths = sourceFiles().map((file) => file.path)

    expect(paths).not.toContain('server/machine-credential/claims.ts')
    expect(paths).not.toContain('server/machine-credential/verify.ts')
  })
})
