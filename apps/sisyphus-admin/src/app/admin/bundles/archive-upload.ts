import type { FieldErrorContent } from '@sisyphus-admin/components/ui'
import {
  ARCHIVE_DIGEST_MISMATCH,
  ARCHIVE_EMPTY,
  ARCHIVE_NOT_GZIP,
  ARCHIVE_TOO_LARGE,
  OBJECT_ALREADY_EXISTS,
} from '@sisyphus-admin/lib/bundles'

/**
 * The result of the upload half of registering a bundle, and how a refusal is worded.
 *
 * Separate from `./upload-action` because a `'use server'` module may export **only** async
 * functions: the types and the message table have to live somewhere else, and putting them beside
 * the action keeps the pairing obvious.
 *
 * Every refusal carries a machine code and a next action, because "invalid input" is not a next
 * action (FR-031). The codes are the ones the upload throws, restated here as operator-facing
 * sentences rather than re-derived — a code with no entry falls through to a generic message that
 * still names the code, so an unmapped failure is searchable rather than mute.
 */

/** What the upload gives back on success — exactly the three fields `register` takes. */
export interface UploadedArchive {
  readonly s3Key: string
  readonly contentDigest: string
  readonly sizeBytes: number
}

export type ArchiveUploadResult =
  | { readonly ok: true; readonly archive: UploadedArchive }
  | { readonly ok: false; readonly error: FieldErrorContent }

/** Refusal when the caller is not an admin. Registration is administrator-only (FR-167). */
export const ARCHIVE_UPLOAD_FORBIDDEN = 'E_BUNDLE_UPLOAD_FORBIDDEN'

/** Refusal when the submitted form carried no file at all. */
export const ARCHIVE_UPLOAD_NO_FILE = 'E_BUNDLE_ARCHIVE_MISSING_FILE'

const ACTIONS: Readonly<Record<string, string>> = {
  [ARCHIVE_EMPTY]: 'Choose a setup bundle archive before registering it.',
  [ARCHIVE_TOO_LARGE]:
    'Remove build output or datasets from the archive; a bundle installs tooling, not data.',
  [ARCHIVE_NOT_GZIP]: 'Repackage as a gzipped tar with an executable setup.sh at its root.',
  [ARCHIVE_DIGEST_MISMATCH]: 'The upload was corrupted in transit; try it again.',
  [OBJECT_ALREADY_EXISTS]: 'Retry the upload; it will be stored under a fresh key.',
  [ARCHIVE_UPLOAD_FORBIDDEN]: 'Ask an administrator to register the bundle for you.',
  [ARCHIVE_UPLOAD_NO_FILE]: 'Choose a setup bundle archive before registering it.',
}

/** The generic next action, used only when a code has no entry above. */
export const UNKNOWN_UPLOAD_ACTION = 'Retry the upload, and quote this code if it happens again.'

/** Turn a code into the error a field renders. */
export const describeUploadFailure = (code: string): FieldErrorContent => ({
  code,
  action: ACTIONS[code] ?? UNKNOWN_UPLOAD_ACTION,
})

/** The code carried by a thrown value, or a generic one. Never a message — messages are not stable. */
export const uploadFailureCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'E_BUNDLE_UPLOAD_FAILED'
}
