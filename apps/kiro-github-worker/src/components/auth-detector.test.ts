// Feature: github-api-key-clone-auth, Property 2: Clone token resolution

import * as fc from 'fast-check'
import type pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkerConfig } from '../lib/types'

// ── Clone Token Resolution Logic ────────────────────────────────────
//
// Extracted from auth-detector.ts — both setupGitHubAppAuth and
// setupPatAuth use the same pattern:
//
//   const getCloneToken =
//     config.githubApiKey != null
//       ? (): Promise<string> => Promise.resolve(config.githubApiKey!)
//       : getToken
//
// We test this logic directly to avoid calling detectAuth, which makes
// real GitHub API calls (App token generation, PAT scope validation).

/**
 * Builds a `getCloneToken` function using the same logic as auth-detector.ts.
 *
 * @param githubApiKey - The optional API key from WorkerConfig
 * @param getToken - The existing getToken function from AuthResult
 * @returns A getCloneToken function matching the AuthResult interface
 */
const buildGetCloneToken = (
  githubApiKey: string | undefined,
  getToken: () => Promise<string>,
): (() => Promise<string>) =>
  githubApiKey != null ? (): Promise<string> => Promise.resolve(githubApiKey) : getToken

// ── Property 2: Clone token resolution ──────────────────────────────
// **Validates: Requirements 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3**

describe('Property 2: Clone token resolution', () => {
  /**
   * Arbitrary for non-empty githubApiKey values.
   * Generates alphanumeric strings resembling real API keys/tokens.
   */
  const apiKeyArb = fc.string({
    unit: fc.constantFrom(
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '_',
      '-',
    ),
    minLength: 1,
    maxLength: 80,
  })

  /**
   * Arbitrary for the token returned by getToken().
   * Simulates installation tokens or PATs.
   */
  const authTokenArb = fc.string({
    unit: fc.constantFrom(
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '_',
      '-',
    ),
    minLength: 1,
    maxLength: 80,
  })

  it('should return githubApiKey when configured, or getToken() value when undefined', async () => {
    const apiKeyPresenceArb = fc.oneof(
      apiKeyArb.map((key) => ({ present: true as const, value: key })),
      fc.constant({ present: false as const, value: undefined as string | undefined }),
    )

    await fc.assert(
      fc.asyncProperty(apiKeyPresenceArb, authTokenArb, async (apiKeyOption, authToken) => {
        const githubApiKey = apiKeyOption.present ? apiKeyOption.value : undefined
        const getToken = (): Promise<string> => Promise.resolve(authToken)

        const getCloneToken = buildGetCloneToken(githubApiKey, getToken)
        const result = await getCloneToken()

        if (githubApiKey != null) {
          // When githubApiKey is configured, getCloneToken returns it directly
          expect(result).toBe(githubApiKey)
        } else {
          // When githubApiKey is undefined, getCloneToken delegates to getToken
          expect(result).toBe(authToken)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('should always return a resolved promise (never throw)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(apiKeyArb, { nil: undefined }),
        authTokenArb,
        async (githubApiKey, authToken) => {
          const getToken = (): Promise<string> => Promise.resolve(authToken)
          const getCloneToken = buildGetCloneToken(githubApiKey, getToken)

          // Should resolve without throwing
          const result = await getCloneToken()
          expect(typeof result).toBe('string')
          expect(result.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ── Unit Tests: Startup Logging ─────────────────────────────────────
// **Validates: Requirements 1.5, 2.6, 4.1, 4.2**

// Mock Octokit so PAT mode doesn't make real API calls
vi.mock('@octokit/rest', () => ({
  // Tests break if not added
  // eslint-disable-next-line prefer-arrow-functions/prefer-arrow-functions
  Octokit: vi.fn().mockImplementation(function () {
    return {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockResolvedValue({
            headers: { 'x-oauth-scopes': 'repo' },
            data: { login: 'test-bot' },
          }),
        },
      },
    }
  }),
}))

/** Builds a minimal PAT-mode WorkerConfig for testing. */
const buildPatConfig = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  githubWebhookSecret: 'test-secret',
  kiroApiKey: 'test-kiro-key',
  kiroCliPath: '/usr/bin/kiro',
  botUsername: 'test-bot',
  githubToken: 'ghp_testtoken123',
  port: 3000,
  webhookPath: '/webhook',
  triggerLabels: ['agent-action'],
  kiroTimeoutMs: 600_000,
  setupScriptTimeoutMs: 120_000,
  workingDirBase: '/tmp',
  logLevel: 'info',
  branchTemplate: 'kiro/{issue_number}/{slug}',
  allowedRepos: null,
  deniedRepos: null,
  a2aEnabled: false,
  a2aPath: '/a2a',
  mcpEnabled: false,
  mcpPath: '/mcp',
  defaultEngine: 'kiro',
  sessionLogEnabled: true,
  sessionLogDir: '/tmp/session-logs',
  sessionLogMaxFiles: 100,
  sessionLogMaxAgeHours: 168,
  ...overrides,
})

/** Creates a mock pino logger with vi.fn() spies on all log methods. */
const createMockLogger = () =>
  ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    fatal: vi.fn(),
  }) as unknown as pino.Logger

describe('Unit: Startup logging', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let detectAuth: typeof import('./auth-detector').detectAuth

  beforeEach(async () => {
    vi.clearAllMocks()
    // Dynamic import so the Octokit mock is active
    const mod = await import('./auth-detector')
    detectAuth = mod.detectAuth
  })

  it('logs at info level when githubApiKey is configured', async () => {
    const logger = createMockLogger()
    const config = buildPatConfig({ githubApiKey: 'ghp_dedicated_clone_key' })

    await detectAuth(config, logger)

    expect(logger.info).toHaveBeenCalledWith('Clone operations will use dedicated GITHUB_API_KEY')
  })

  it('logs at debug level when githubApiKey is not configured', async () => {
    const logger = createMockLogger()
    const config = buildPatConfig({ githubApiKey: undefined })

    await detectAuth(config, logger)

    expect(logger.debug).toHaveBeenCalledWith(
      'Clone operations will use Auth_Detector-provided token',
    )
  })

  it('returns unchanged octokit and getToken() when githubApiKey is configured', async () => {
    const logger = createMockLogger()
    const patToken = 'ghp_my_pat_token'
    const config = buildPatConfig({ githubToken: patToken, githubApiKey: 'ghp_clone_key' })

    const result = await detectAuth(config, logger)

    // octokit should still be an object (the mocked Octokit instance)
    expect(result.octokit).toBeDefined()
    expect(result.octokit.rest.users.getAuthenticated).toBeDefined()

    // getToken() should still return the PAT token, not the API key
    const token = await result.getToken()
    expect(token).toBe(patToken)

    // getCloneToken() should return the API key
    const cloneToken = await result.getCloneToken()
    expect(cloneToken).toBe('ghp_clone_key')
  })
})
