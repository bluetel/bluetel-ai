import { randomUUID } from 'node:crypto'

/**
 * Where a bundle archive lives in private storage.
 *
 * **The key is the first half of FR-090's immutability**, and it is built so that overwriting is
 * not a thing a caller can accidentally do. Two independent components make every upload's key
 * unique:
 *
 * 1. a fresh `uploadId` per call, so two uploads of the *same* bytes still land on different keys;
 * 2. the content digest, so two uploads of *different* bytes can never share a key even if an
 *    identifier were somehow reused.
 *
 * A key derived from the bundle's name or id alone — `bundles/<name>.tar.gz`, or
 * `bundles/<id>/current.tar.gz` — is the shape that makes "replace the archive" a `PutObject` over
 * the top of the archive an in-flight workflow is about to download. There is deliberately no
 * `latest` or `current` alias here for the same reason: an alias is a mutable pointer, and a
 * mutable pointer is what the version table exists to replace.
 *
 * The bundle name appears only as a slug, for human legibility in the console. Nothing resolves a
 * key by name.
 */

/** Prefix for every archive. Kept in one place so a bucket policy can be written against it. */
export const BUNDLE_ARCHIVE_PREFIX = 'bundles'

/** The suffix the archive format implies (contracts/setup-bundle.md). */
export const BUNDLE_ARCHIVE_SUFFIX = '.tar.gz'

/** Longest slug taken from a bundle name, so one long name cannot dominate the key. */
const MAX_SLUG_LENGTH = 48

/**
 * A lower-case, dash-separated, path-safe fragment of a bundle name.
 *
 * Everything outside `[a-z0-9]` collapses to a single dash and the result is trimmed, so a name
 * containing `/`, `..` or a control character cannot steer the key out of its prefix. A name with
 * no usable characters at all yields `bundle` rather than an empty segment — an empty segment
 * would produce a double slash and a key that no longer matches the prefix a policy is written
 * against.
 */
export const bundleNameSlug = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')

  return slug === '' ? 'bundle' : slug
}

export interface BundleArchiveKeyInput {
  readonly bundleName: string
  /** Lower-case hex sha256 of the bytes being stored. */
  readonly contentDigest: string
  /**
   * Unique per upload. Defaults to a fresh UUID; passed explicitly only by tests, which need the
   * key to be predictable. A caller that reuses one has defeated the point of it.
   */
  readonly uploadId?: string
}

/** Build the object key for one upload. Never the same twice. */
export const bundleArchiveKey = ({
  bundleName,
  contentDigest,
  uploadId = randomUUID(),
}: BundleArchiveKeyInput): string =>
  `${BUNDLE_ARCHIVE_PREFIX}/${bundleNameSlug(bundleName)}/${uploadId}-${contentDigest}${BUNDLE_ARCHIVE_SUFFIX}`
