import { describe, expect, it } from 'vitest'

import { clientSchemas, processEnvKeys, serverSchemas } from './env-schemas'

describe('serverSchemas', () => {
  describe('required values', () => {
    it('rejects a missing database URL', () => {
      expect(() => serverSchemas.DATABASE_URL.parse(undefined)).toThrow()
    })

    it('rejects a database value that is not a URL', () => {
      expect(() => serverSchemas.DATABASE_URL.parse('not-a-url')).toThrow()
      expect(serverSchemas.DATABASE_URL.parse('postgres://user@host:5432/sisyphus')).toBe(
        'postgres://user@host:5432/sisyphus',
      )
    })

    it('rejects a missing Google OAuth client', () => {
      expect(() => serverSchemas.AUTH_GOOGLE_ID.parse(undefined)).toThrow()
      expect(() => serverSchemas.AUTH_GOOGLE_SECRET.parse(undefined)).toThrow()
    })

    it('rejects a missing Auth.js secret', () => {
      expect(() => serverSchemas.AUTH_SECRET.parse(undefined)).toThrow()
      expect(() => serverSchemas.AUTH_SECRET.parse('')).toThrow()
    })

    it('rejects a missing machine credential secret, so the machine surface cannot run unverified', () => {
      expect(() => serverSchemas.SISYPHUS_MACHINE_CREDENTIAL_SECRET.parse(undefined)).toThrow()
    })

    it('rejects a missing Slack token, so a mounted machine surface cannot notify nobody silently', () => {
      expect(() => serverSchemas.SISYPHUS_SLACK_BOT_TOKEN.parse(undefined)).toThrow()
      expect(() => serverSchemas.SISYPHUS_SLACK_BOT_TOKEN.parse('')).toThrow()
    })

    it('requires an absolute panel URL, because it is written into a Slack message (FR-137)', () => {
      expect(() => serverSchemas.SISYPHUS_PANEL_URL.parse(undefined)).toThrow()
      expect(() => serverSchemas.SISYPHUS_PANEL_URL.parse('/workflows')).toThrow()
      expect(serverSchemas.SISYPHUS_PANEL_URL.parse('https://sisyphus.example.com')).toBe(
        'https://sisyphus.example.com',
      )
    })

    it('rejects every missing bucket name', () => {
      expect(() => serverSchemas.SISYPHUS_LOGS_BUCKET.parse(undefined)).toThrow()
      expect(() => serverSchemas.SISYPHUS_BUNDLES_BUCKET.parse(undefined)).toThrow()
      expect(() => serverSchemas.SISYPHUS_ARTIFACTS_BUCKET.parse(undefined)).toThrow()
    })

    it('rejects a missing stage', () => {
      expect(() => serverSchemas.SISYPHUS_STAGE.parse(undefined)).toThrow()
    })
  })

  describe('SISYPHUS_PERMITTED_EMAIL_DOMAINS', () => {
    it('parses a single domain', () => {
      expect(serverSchemas.SISYPHUS_PERMITTED_EMAIL_DOMAINS.parse('bluetel.co.uk')).toEqual([
        'bluetel.co.uk',
      ])
    })

    it('parses a comma-separated list, trimming whitespace', () => {
      expect(
        serverSchemas.SISYPHUS_PERMITTED_EMAIL_DOMAINS.parse('bluetel.co.uk, example.com'),
      ).toEqual(['bluetel.co.uk', 'example.com'])
    })

    it('drops empty entries left by a trailing comma', () => {
      expect(serverSchemas.SISYPHUS_PERMITTED_EMAIL_DOMAINS.parse('bluetel.co.uk,,')).toEqual([
        'bluetel.co.uk',
      ])
    })

    it('rejects a list that resolves to nothing, rather than permitting no one silently', () => {
      expect(() => serverSchemas.SISYPHUS_PERMITTED_EMAIL_DOMAINS.parse(',')).toThrow()
      expect(() => serverSchemas.SISYPHUS_PERMITTED_EMAIL_DOMAINS.parse(undefined)).toThrow()
    })
  })

  describe('optional and defaulted values', () => {
    it('defaults the region', () => {
      expect(serverSchemas.AWS_REGION.parse(undefined)).toBe('eu-west-2')
      expect(serverSchemas.AWS_REGION.parse('us-east-1')).toBe('us-east-1')
    })

    it('allows the webhook signing secret to be absent until an integration needs it', () => {
      expect(serverSchemas.SISYPHUS_WEBHOOK_SIGNING_SECRET.parse(undefined)).toBeUndefined()
    })
  })

  it('holds no snapshot bucket — the panel never serves session state', () => {
    expect(Object.keys(serverSchemas)).not.toContain('SISYPHUS_SNAPSHOTS_BUCKET')
  })
})

describe('clientSchemas', () => {
  it('exposes only NEXT_PUBLIC_ variables, so nothing secret reaches the browser bundle', () => {
    for (const key of Object.keys(clientSchemas)) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(true)
    }
  })

  it('accepts the three known environments and rejects anything else', () => {
    expect(clientSchemas.NEXT_PUBLIC_NODE_ENV.parse('development')).toBe('development')
    expect(clientSchemas.NEXT_PUBLIC_NODE_ENV.parse('test')).toBe('test')
    expect(clientSchemas.NEXT_PUBLIC_NODE_ENV.parse('production')).toBe('production')
    expect(() => clientSchemas.NEXT_PUBLIC_NODE_ENV.parse('staging')).toThrow()
  })

  it('requires an absolute site URL', () => {
    expect(() => clientSchemas.NEXT_PUBLIC_SITE_URL.parse('/panel')).toThrow()
    expect(clientSchemas.NEXT_PUBLIC_SITE_URL.parse('https://sisyphus.example.com')).toBe(
      'https://sisyphus.example.com',
    )
  })
})

describe('the server/client split', () => {
  it('keeps every credential off the client schema', () => {
    const clientKeys = Object.keys(clientSchemas)

    for (const key of ['AUTH_SECRET', 'AUTH_GOOGLE_SECRET', 'DATABASE_URL']) {
      expect(clientKeys).not.toContain(key)
    }
  })

  it('shares no key between the two schemas', () => {
    const serverKeys = new Set(Object.keys(serverSchemas))

    for (const key of Object.keys(clientSchemas)) {
      expect(serverKeys.has(key)).toBe(false)
    }
  })
})

describe('processEnvKeys', () => {
  it('marks every server key secret and every client key not', () => {
    expect(processEnvKeys.filter((entry) => entry.secret).map((entry) => entry.key)).toEqual(
      Object.keys(serverSchemas),
    )
    expect(processEnvKeys.filter((entry) => !entry.secret).map((entry) => entry.key)).toEqual(
      Object.keys(clientSchemas),
    )
  })

  it('covers both schemas exactly once', () => {
    expect(processEnvKeys).toHaveLength(
      Object.keys(serverSchemas).length + Object.keys(clientSchemas).length,
    )
  })
})
