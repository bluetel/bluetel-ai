import { SISYPHUS_TRPC_ENDPOINT } from '@bluetel-ai/sisyphus-api/client'
import { describe, expect, it } from 'vitest'

import { resolveBaseUrl, resolveTrpcUrl } from './base-url'

/** Run `body` with a stand-in browser realm, then take it away again. */
const inBrowser = <T>(origin: string, body: () => T): T => {
  const globals = globalThis as { window?: unknown }
  globals.window = { location: { origin } }
  try {
    return body()
  } finally {
    delete globals.window
  }
}

describe('resolveBaseUrl', () => {
  it('uses the configured site URL when there is no origin to read', () => {
    expect(resolveBaseUrl('https://sisyphus.example.com')).toBe('https://sisyphus.example.com')
  })

  it('trims a trailing slash, so the endpoint is not appended to a double slash', () => {
    expect(resolveBaseUrl('https://sisyphus.example.com/')).toBe('https://sisyphus.example.com')
  })

  it('prefers the live origin in a browser, so a preview deployment talks to itself', () => {
    expect(
      inBrowser('https://preview-42.example.com', () =>
        resolveBaseUrl('https://sisyphus.example.com'),
      ),
    ).toBe('https://preview-42.example.com')
  })
})

describe('resolveTrpcUrl', () => {
  it('mounts on the endpoint the contract package exports, not a restated path', () => {
    expect(resolveTrpcUrl('https://sisyphus.example.com')).toBe(
      `https://sisyphus.example.com${SISYPHUS_TRPC_ENDPOINT}`,
    )
  })

  it('is absolute on the server, which is what httpBatchLink requires there', () => {
    expect(resolveTrpcUrl('https://sisyphus.example.com')).toMatch(/^https:\/\//)
  })

  it('follows the live origin in a browser', () => {
    expect(
      inBrowser('http://localhost:3003', () => resolveTrpcUrl('https://sisyphus.example.com')),
    ).toBe(`http://localhost:3003${SISYPHUS_TRPC_ENDPOINT}`)
  })
})
