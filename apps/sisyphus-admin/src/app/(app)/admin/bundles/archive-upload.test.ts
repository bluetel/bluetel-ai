import { ARCHIVE_NOT_GZIP, OBJECT_ALREADY_EXISTS } from '@sisyphus-admin/lib/bundles'
import { describe, expect, it } from 'vitest'

import {
  ARCHIVE_UPLOAD_FORBIDDEN,
  ARCHIVE_UPLOAD_NO_FILE,
  describeUploadFailure,
  UNKNOWN_UPLOAD_ACTION,
  uploadFailureCode,
} from './archive-upload'

describe('describeUploadFailure', () => {
  it('gives every known refusal a next action, not a restatement of the failure', () => {
    for (const code of [
      ARCHIVE_NOT_GZIP,
      OBJECT_ALREADY_EXISTS,
      ARCHIVE_UPLOAD_FORBIDDEN,
      ARCHIVE_UPLOAD_NO_FILE,
    ]) {
      const described = describeUploadFailure(code)
      expect(described.code).toBe(code)
      expect(described.action).not.toBe(UNKNOWN_UPLOAD_ACTION)
      expect(described.action.length).toBeGreaterThan(0)
    }
  })

  it('tells an author how to repackage a bundle that is not a gzipped tar', () => {
    expect(describeUploadFailure(ARCHIVE_NOT_GZIP).action).toContain('gzipped tar')
  })

  it('still names an unmapped code, so a novel failure is searchable rather than mute', () => {
    const described = describeUploadFailure('E_SOMETHING_NEW')

    expect(described.code).toBe('E_SOMETHING_NEW')
    expect(described.action).toBe(UNKNOWN_UPLOAD_ACTION)
  })
})

describe('uploadFailureCode', () => {
  it('reads the code off a coded error', () => {
    expect(uploadFailureCode(Object.assign(new Error('x'), { code: ARCHIVE_NOT_GZIP }))).toBe(
      ARCHIVE_NOT_GZIP,
    )
  })

  it('falls back to a generic code rather than leaking a message as one', () => {
    // Messages are not stable and are not searchable; a code is both.
    expect(uploadFailureCode(new Error('Connection reset by peer'))).toBe('E_BUNDLE_UPLOAD_FAILED')
    expect(uploadFailureCode(undefined)).toBe('E_BUNDLE_UPLOAD_FAILED')
    expect(uploadFailureCode('a string')).toBe('E_BUNDLE_UPLOAD_FAILED')
  })
})
