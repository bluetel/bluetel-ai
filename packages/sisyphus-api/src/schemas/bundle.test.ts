import { describe, expect, it } from 'vitest'

import {
  contentDigest,
  listBundlesInput,
  registerBundleInput,
  replaceBundleArchiveInput,
  setBundleEnabledInput,
  updateBundleMetadataInput,
  validateBundleInput,
} from './bundle'

const ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const DIGEST = 'a'.repeat(64)

describe('contentDigest', () => {
  it('accepts a lower-case sha256 and rejects anything else', () => {
    expect(contentDigest.safeParse(DIGEST).success).toBe(true)
    expect(contentDigest.safeParse(DIGEST.toUpperCase()).success).toBe(false)
    expect(contentDigest.safeParse('a'.repeat(63)).success).toBe(false)
  })
})

describe('listBundlesInput', () => {
  it('defaults to the enabled list, which is what a profile builder needs (FR-086)', () => {
    expect(listBundlesInput.parse({})).toMatchObject({
      enabledOnly: true,
      includeArchived: false,
    })
  })
})

describe('registerBundleInput', () => {
  const valid = {
    name: 'client-alpha',
    s3Key: 'bundles/client-alpha-1.tar.zst',
    contentDigest: DIGEST,
    sizeBytes: 4096,
  }

  it('records the archive and its digest together — the digest is verified at download', () => {
    expect(registerBundleInput.parse(valid)).toMatchObject(valid)
  })

  it('defaults spendCapsEnforceable to false, so an unproven bundle is not launched under a cap', () => {
    expect(registerBundleInput.parse(valid).spendCapsEnforceable).toBe(false)
  })

  it('rejects a zero-byte archive', () => {
    expect(registerBundleInput.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(false)
  })
})

describe('replaceBundleArchiveInput', () => {
  it('is a separate input from metadata, because it creates a version (FR-090)', () => {
    expect(Object.keys(replaceBundleArchiveInput.shape).sort()).toStrictEqual([
      'contentDigest',
      's3Key',
      'setupBundleId',
      'sizeBytes',
    ])
  })
})

describe('updateBundleMetadataInput', () => {
  it('cannot touch the archive — a bundle is immutable once registered', () => {
    const keys = Object.keys(updateBundleMetadataInput.shape)

    expect(keys).not.toContain('s3Key')
    expect(keys).not.toContain('contentDigest')
  })

  it('accepts a partial edit', () => {
    expect(updateBundleMetadataInput.parse({ setupBundleId: ID, name: 'renamed' })).toMatchObject({
      name: 'renamed',
    })
  })
})

describe('setBundleEnabledInput and validateBundleInput', () => {
  it('take exactly what they need', () => {
    expect(setBundleEnabledInput.parse({ setupBundleId: ID, enabled: true })).toStrictEqual({
      setupBundleId: ID,
      enabled: true,
    })
    expect(validateBundleInput.parse({ setupBundleVersionId: ID })).toStrictEqual({
      setupBundleVersionId: ID,
    })
  })

  it('validates a **version**, not a bundle — a bundle has no single content to prove', () => {
    expect(Object.keys(validateBundleInput.shape)).toStrictEqual(['setupBundleVersionId'])
  })
})
