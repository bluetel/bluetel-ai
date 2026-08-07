import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * **There is one definition of a machine credential, and this test is what keeps it that way.**
 *
 * The claim vocabulary and the verifier used to exist twice — once here beside the mint, once in
 * the panel's `/api/machine` mount — because neither application can import the other. Both copies
 * were pinned to their literals by their own tests and both carried a comment saying the other
 * existed. That is not a mitigation: two verifiers that can disagree about what a valid credential
 * *is* is a security defect waiting for a divergent edit, and the mismatch is silent until an
 * instance is running.
 *
 * Both now import `@bluetel-ai/sisyphus-api/server`. A comment cannot stop someone re-introducing
 * a local copy — "it is only one constant, and the import is awkward here" is exactly how the
 * first copy was written — so this scans the application's own source and fails if any of the
 * vocabulary reappears in it.
 *
 * Test files are exempt, and have to be: this one names the forbidden strings in order to look for
 * them, and `mint-verify-round-trip.test.ts` legitimately asserts against them.
 */

const here = dirname(fileURLToPath(import.meta.url))
const applicationSource = join(here, '..')

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
 * The two subject prefixes are matched as **quoted** literals: `workflow:<id>` appears in prose
 * all over this application and forbidding the bare string would forbid explaining the format.
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
  // The short window and the signed ceiling, as they would be written out again.
  '15 * 60 * 1000',
  '12 * 60 * 60 * 1000',
]

/**
 * Where this application is allowed to reach for a JOSE implementation.
 *
 * Signing is the control plane's alone, so the mint holds the only production `jose` import here.
 * Verification takes none: the shared verifier is handed `jose`'s `jwtVerify` by whichever host
 * mounts the machine surface, and this application does not mount one.
 */
const JOSE_IMPORT_ALLOWED_IN = ['credentials/mint.ts']

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

  it('reaches for a JOSE implementation only where a credential is signed', () => {
    const offenders = sourceFiles()
      .filter((file) => file.text.includes("from 'jose'"))
      .map((file) => file.path)
      .filter((path) => !JOSE_IMPORT_ALLOWED_IN.includes(path))

    expect(offenders).toStrictEqual([])
  })

  it('has no local module named for the vocabulary or the verifier', () => {
    // `credentials/claims.ts` and `credentials/verify.ts` were the two copies. Their absence is
    // the fix; their reappearance under the same names would be the regression.
    const paths = sourceFiles().map((file) => file.path)

    expect(paths).not.toContain('credentials/claims.ts')
    expect(paths).not.toContain('credentials/verify.ts')
  })
})
