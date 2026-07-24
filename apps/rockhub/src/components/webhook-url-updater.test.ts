import { createAppAuth } from '@octokit/auth-app'
import type pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWebhookUrlUpdater } from './webhook-url-updater'

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}))

const mockCreateAppAuth = vi.mocked(createAppAuth)

interface MockLogger {
  child: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  fatal: ReturnType<typeof vi.fn>
  trace: ReturnType<typeof vi.fn>
  level: string
}

const createMockLogger = (): pino.Logger => {
  const mock: MockLogger = {
    child: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: 'info',
  }
  mock.child.mockReturnValue(mock)
  return mock as unknown as pino.Logger
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createWebhookUrlUpdater', () => {
  const config = {
    appId: '12345',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
  }
  let logger: ReturnType<typeof createMockLogger>
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = createMockLogger()
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    mockCreateAppAuth.mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'fake-jwt-token' }) as never,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends PATCH to /app/hook/config with correct headers and body on success', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
    })

    const updater = createWebhookUrlUpdater(config, { logger })
    await updater.updateWebhookUrl('https://example.trycloudflare.com/webhook')

    expect(fetchSpy).toHaveBeenCalledWith('https://api.github.com/app/hook/config', {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer fake-jwt-token',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://example.trycloudflare.com/webhook' }),
    })
  })

  it('logs at info level on 2xx response', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
    })

    const updater = createWebhookUrlUpdater(config, { logger })
    await updater.updateWebhookUrl('https://tunnel.example.com/webhook')

    const childLogger = ((logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value ??
      logger) as MockLogger
    expect(childLogger.info).toHaveBeenCalledWith(
      { webhookUrl: 'https://tunnel.example.com/webhook' },
      'GitHub App webhook URL updated',
    )
  })

  it('logs at warn level on non-2xx response and does not throw', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue('Forbidden'),
    })

    const updater = createWebhookUrlUpdater(config, { logger })

    // Should not throw
    await expect(
      updater.updateWebhookUrl('https://tunnel.example.com/webhook'),
    ).resolves.toBeUndefined()

    const childLogger = ((logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value ??
      logger) as MockLogger
    expect(childLogger.warn).toHaveBeenCalledWith(
      { status: 403, body: 'Forbidden', webhookUrl: 'https://tunnel.example.com/webhook' },
      'Failed to update GitHub App webhook URL',
    )
  })

  it('logs at warn level on thrown exception and does not rethrow', async () => {
    const networkError = new Error('Network failure')
    fetchSpy.mockRejectedValue(networkError)

    const updater = createWebhookUrlUpdater(config, { logger })

    // Should not throw
    await expect(
      updater.updateWebhookUrl('https://tunnel.example.com/webhook'),
    ).resolves.toBeUndefined()

    const childLogger = ((logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value ??
      logger) as MockLogger
    expect(childLogger.warn).toHaveBeenCalledWith(
      { err: networkError, webhookUrl: 'https://tunnel.example.com/webhook' },
      'Exception while updating GitHub App webhook URL',
    )
  })

  it('logs at warn level when auth fails and does not throw', async () => {
    const authError = new Error('Invalid private key')
    mockCreateAppAuth.mockReturnValue(vi.fn().mockRejectedValue(authError) as never)

    const updater = createWebhookUrlUpdater(config, { logger })

    await expect(
      updater.updateWebhookUrl('https://tunnel.example.com/webhook'),
    ).resolves.toBeUndefined()

    const childLogger = ((logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value ??
      logger) as MockLogger
    expect(childLogger.warn).toHaveBeenCalledWith(
      { err: authError, webhookUrl: 'https://tunnel.example.com/webhook' },
      'Exception while updating GitHub App webhook URL',
    )
  })

  it('only sends the url field in the PATCH body (Req 17.8)', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 })

    const updater = createWebhookUrlUpdater(config, { logger })
    await updater.updateWebhookUrl('https://tunnel.example.com/webhook')

    const callArgs = fetchSpy.mock.calls[0] as [string, { body: string }]
    const callBody = JSON.parse(callArgs[1].body) as Record<string, unknown>
    expect(Object.keys(callBody)).toEqual(['url'])
    expect(callBody.url).toBe('https://tunnel.example.com/webhook')
  })

  it('uses createAppAuth with appId and privateKey from config', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 })

    const updater = createWebhookUrlUpdater(config, { logger })
    await updater.updateWebhookUrl('https://tunnel.example.com/webhook')

    expect(mockCreateAppAuth).toHaveBeenCalledWith({
      appId: '12345',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    })
  })
})
