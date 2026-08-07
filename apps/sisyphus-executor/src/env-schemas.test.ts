import { describe, expect, it } from 'vitest'

import { ENVELOPE_ONLY_KEYS, clientSchemas, processEnvKeys, serverSchemas } from './env-schemas'

describe('serverSchemas', () => {
  it('requires the stage and the machine surface URL', () => {
    expect(() => serverSchemas.SISYPHUS_STAGE.parse(undefined)).toThrow()
    expect(() => serverSchemas.SISYPHUS_MACHINE_SURFACE_URL.parse(undefined)).toThrow()
    expect(() => serverSchemas.SISYPHUS_MACHINE_SURFACE_URL.parse('machine')).toThrow()
  })

  it('requires the forge API base, and requires it to be a URL', () => {
    expect(() => serverSchemas.SISYPHUS_FORGE_API_URL.parse(undefined)).toThrow()
    expect(() => serverSchemas.SISYPHUS_FORGE_API_URL.parse('api.forge.example')).toThrow()
    expect(serverSchemas.SISYPHUS_FORGE_API_URL.parse('https://api.forge.example')).toBe(
      'https://api.forge.example',
    )
  })

  it('requires all four bucket names', () => {
    for (const key of [
      'SISYPHUS_LOGS_BUCKET',
      'SISYPHUS_SNAPSHOTS_BUCKET',
      'SISYPHUS_BUNDLES_BUCKET',
      'SISYPHUS_ARTIFACTS_BUCKET',
    ] as const) {
      expect(() => serverSchemas[key].parse(undefined)).toThrow()
    }
  })

  it('defaults the region', () => {
    expect(serverSchemas.AWS_REGION.parse(undefined)).toBe('eu-west-2')
  })

  it('pins the workspace root to /workspace, because a restored session is unfindable otherwise', () => {
    expect(serverSchemas.SISYPHUS_WORKSPACE_ROOT.parse(undefined)).toBe('/workspace')
  })
})

describe('the envelope boundary', () => {
  const declaredKeys = Object.keys(serverSchemas)

  it('declares no job parameter and no credential — those arrive in the user-data envelope', () => {
    for (const key of ENVELOPE_ONLY_KEYS) {
      expect(declaredKeys).not.toContain(key)
    }
  })

  it('declares nothing that reads like a credential', () => {
    for (const key of declaredKeys) {
      expect(/CREDENTIAL|SECRET|TOKEN|PASSWORD|PRIVATE_KEY/.test(key)).toBe(false)
    }
  })

  it('declares no database access at all — the executor imports types only', () => {
    for (const key of declaredKeys) {
      expect(/DATABASE|POSTGRES|DB_/.test(key)).toBe(false)
    }
  })

  it('stays small: every entry is instance-level, so growth here is the smell', () => {
    expect(declaredKeys).toHaveLength(9)
  })

  it('declares a forge URL and no forge credential, in any spelling', () => {
    expect(declaredKeys).toContain('SISYPHUS_FORGE_API_URL')
    expect(declaredKeys.filter((key) => /FORGE/.test(key))).toStrictEqual([
      'SISYPHUS_FORGE_API_URL',
    ])
  })
})

describe('the client schema', () => {
  it('is empty — the executor has no browser bundle', () => {
    expect(Object.keys(clientSchemas)).toEqual([])
  })
})

describe('processEnvKeys', () => {
  it('covers the server schema exactly', () => {
    expect(processEnvKeys.map((entry) => entry.key)).toEqual(Object.keys(serverSchemas))
    expect(processEnvKeys.every((entry) => entry.secret)).toBe(true)
  })
})
