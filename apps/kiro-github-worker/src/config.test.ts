/* eslint-disable @typescript-eslint/no-non-null-assertion */
// Feature: kiro-github-worker, Property 5: Config parsing applies defaults for absent optional variables
// Feature: kiro-github-worker, Property 6: Auth mode detection selects correct mode from environment
// Feature: rocky-a2a-mode, Property 9: A2A config defaults

import fs from 'node:fs'
import os from 'node:os'

import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { detectAuthMode, parseConfig } from './config'
import type { WorkerConfig } from './lib/types'

// ── Helpers ─────────────────────────────────────────────────────────

/** Base required env vars that must always be present for parseConfig to succeed. */
const requiredEnv = (authMode: 'pat' | 'app' | 'both'): Record<string, string> => {
  const base: Record<string, string> = {
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    KIRO_API_KEY: 'test-api-key',
    KIRO_CLI_PATH: '/bin/sh',
    BOT_USERNAME: 'rocky-bot',
    BRANCH_TEMPLATE: 'kiro/{issue_number}-{slug}',
  }

  if (authMode === 'pat' || authMode === 'both') {
    base['GITHUB_TOKEN'] = 'ghp_testtoken123'
  }
  if (authMode === 'app' || authMode === 'both') {
    base['GITHUB_APP_ID'] = '12345'
    base['GITHUB_APP_PRIVATE_KEY'] = 'test-private-key'
    base['GITHUB_APP_INSTALLATION_ID'] = '67890'
  }

  return base
}

/** Documented default values for optional config variables. */
const DEFAULTS = {
  port: 3000,
  webhookPath: '/webhook',
  triggerLabels: ['agent-action'],
  kiroTimeoutMs: 600_000,
  setupScriptTimeoutMs: 120_000,
  workingDirBase: os.tmpdir(),
  logLevel: 'info' as const,
  allowedRepos: null,
  deniedRepos: null,
}

/**
 * Map of optional env var names to their config key and a function to
 * convert the env string value to the expected config value.
 */
const OPTIONAL_VARS: Record<
  string,
  {
    configKey: keyof WorkerConfig
    defaultValue: unknown
    arbitrary: fc.Arbitrary<string>
    toConfigValue: (envVal: string) => unknown
  }
> = {
  PORT: {
    configKey: 'port',
    defaultValue: DEFAULTS.port,
    arbitrary: fc.integer({ min: 1, max: 65535 }).map(String),
    toConfigValue: (v) => parseInt(v, 10),
  },
  WEBHOOK_PATH: {
    configKey: 'webhookPath',
    defaultValue: DEFAULTS.webhookPath,
    arbitrary: fc
      .string({ unit: fc.constantFrom('/', 'a', 'b', 'c', '-', '_'), minLength: 1, maxLength: 20 })
      .map((s) => (s.startsWith('/') ? s : `/${s}`)),
    toConfigValue: (v) => v,
  },
  TRIGGER_LABELS: {
    configKey: 'triggerLabels',
    defaultValue: DEFAULTS.triggerLabels,
    arbitrary: fc
      .array(
        fc.string({ unit: fc.constantFrom('a', 'b', 'c', '-', '_'), minLength: 1, maxLength: 10 }),
        {
          minLength: 1,
          maxLength: 3,
        },
      )
      .map((arr) => arr.join(',')),
    toConfigValue: (v) =>
      v
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
  },
  KIRO_TIMEOUT_MS: {
    configKey: 'kiroTimeoutMs',
    defaultValue: DEFAULTS.kiroTimeoutMs,
    arbitrary: fc.integer({ min: 1, max: 3_600_000 }).map(String),
    toConfigValue: (v) => parseInt(v, 10),
  },
  SETUP_SCRIPT_TIMEOUT_MS: {
    configKey: 'setupScriptTimeoutMs',
    defaultValue: DEFAULTS.setupScriptTimeoutMs,
    arbitrary: fc.integer({ min: 1, max: 600_000 }).map(String),
    toConfigValue: (v) => parseInt(v, 10),
  },
  WORKING_DIR_BASE: {
    configKey: 'workingDirBase',
    defaultValue: DEFAULTS.workingDirBase,
    arbitrary: fc.constant('/tmp/test-working-dir'),
    toConfigValue: (v) => v,
  },
  LOG_LEVEL: {
    configKey: 'logLevel',
    defaultValue: DEFAULTS.logLevel,
    arbitrary: fc.constantFrom('debug', 'info', 'warn', 'error'),
    toConfigValue: (v) => v,
  },
}

const OPTIONAL_VAR_NAMES = Object.keys(OPTIONAL_VARS)

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(fs, 'accessSync').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Property 5: Config parsing applies defaults for absent optional variables ──
// **Validates: Requirements 8.2**

describe('Property 5: Config parsing applies defaults for absent optional variables', () => {
  it('should use documented defaults for all absent optional variables and provided values for present ones', () => {
    const subsetArb = fc.subarray(OPTIONAL_VAR_NAMES, {
      minLength: 0,
      maxLength: OPTIONAL_VAR_NAMES.length,
    })

    fc.assert(
      fc.property(subsetArb, (presentVarNames) => {
        const env = { ...requiredEnv('pat') }
        const expectedOverrides: Record<string, unknown> = {}

        for (const varName of presentVarNames) {
          const spec = OPTIONAL_VARS[varName]
          const sampleValue = fc.sample(spec.arbitrary, 1)[0]
          env[varName] = sampleValue
          expectedOverrides[spec.configKey] = spec.toConfigValue(sampleValue)
        }

        const config = parseConfig(env, { throwOnError: true })

        for (const [varName, spec] of Object.entries(OPTIONAL_VARS)) {
          const configValue = config[spec.configKey]

          if (presentVarNames.includes(varName)) {
            expect(configValue).toEqual(expectedOverrides[spec.configKey])
          } else {
            expect(configValue).toEqual(spec.defaultValue)
          }
        }
      }),
      { numRuns: 100 },
    )
  })

  it('should return all defaults when no optional variables are provided', () => {
    const env = requiredEnv('pat')
    const config = parseConfig(env, { throwOnError: true })

    expect(config.port).toBe(DEFAULTS.port)
    expect(config.webhookPath).toBe(DEFAULTS.webhookPath)
    expect(config.triggerLabels).toEqual(DEFAULTS.triggerLabels)
    expect(config.kiroTimeoutMs).toBe(DEFAULTS.kiroTimeoutMs)
    expect(config.setupScriptTimeoutMs).toBe(DEFAULTS.setupScriptTimeoutMs)
    expect(config.workingDirBase).toBe(DEFAULTS.workingDirBase)
    expect(config.logLevel).toBe(DEFAULTS.logLevel)
    expect(config.allowedRepos).toBe(DEFAULTS.allowedRepos)
    expect(config.deniedRepos).toBe(DEFAULTS.deniedRepos)
  })

  it('should use provided values when all optional variables are set', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      PORT: '8080',
      WEBHOOK_PATH: '/hooks',
      TRIGGER_LABELS: 'label-a,label-b',
      KIRO_TIMEOUT_MS: '300000',
      SETUP_SCRIPT_TIMEOUT_MS: '60000',
      WORKING_DIR_BASE: '/tmp/custom',
      LOG_LEVEL: 'debug',
      BRANCH_TEMPLATE: 'feature/{issue_number}',
      ALLOWED_REPOS: 'org/repo1,org/repo2',
      DENIED_REPOS: 'org/repo3',
    }

    const config = parseConfig(env, { throwOnError: true })

    expect(config.port).toBe(8080)
    expect(config.webhookPath).toBe('/hooks')
    expect(config.triggerLabels).toEqual(['label-a', 'label-b'])
    expect(config.kiroTimeoutMs).toBe(300_000)
    expect(config.setupScriptTimeoutMs).toBe(60_000)
    expect(config.workingDirBase).toBe('/tmp/custom')
    expect(config.logLevel).toBe('debug')
    expect(config.branchTemplate).toBe('feature/{issue_number}')
    expect(config.allowedRepos).toEqual(['org/repo1', 'org/repo2'])
    expect(config.deniedRepos).toEqual(['org/repo3'])
  })

  it('should fail validation when BRANCH_TEMPLATE is missing', () => {
    const env = requiredEnv('pat')
    // Remove BRANCH_TEMPLATE from the required env to simulate it being absent
    delete env['BRANCH_TEMPLATE']

    expect(() => parseConfig(env, { throwOnError: true })).toThrow(/BRANCH_TEMPLATE/)
  })

  it('should fail validation when BRANCH_TEMPLATE is empty', () => {
    const env = { ...requiredEnv('pat'), BRANCH_TEMPLATE: '' }

    expect(() => parseConfig(env, { throwOnError: true })).toThrow(/BRANCH_TEMPLATE/)
  })
})

// ── Property 6: Auth mode detection selects correct mode from environment ──
// **Validates: Requirements 8.3, 17.2, 17.3, 17.4**

describe('Property 6: Auth mode detection selects correct mode from environment', () => {
  it('should select correct auth mode for any combination of token/app presence', () => {
    const tokenArb = fc.string({
      unit: fc.constantFrom('a', 'b', 'c', '1', '2', '3'),
      minLength: 1,
      maxLength: 20,
    })
    const appIdArb = fc.string({
      unit: fc.constantFrom('1', '2', '3', '4', '5'),
      minLength: 1,
      maxLength: 10,
    })
    const appKeyArb = fc
      .string({
        unit: fc.constantFrom('a', 'b', 'c', 'A', 'B', 'C', '1', '2', '3', '+', '/', '=', '\n'),
        minLength: 1,
        maxLength: 30,
      })
      .map((body) => `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`)
    const appInstallIdArb = fc.string({
      unit: fc.constantFrom('1', '2', '3', '4', '5'),
      minLength: 1,
      maxLength: 10,
    })

    const authCombinationArb = fc.record({
      hasToken: fc.boolean(),
      hasApp: fc.boolean(),
      tokenValue: tokenArb,
      appIdValue: appIdArb,
      appKeyValue: appKeyArb,
      appInstallIdValue: appInstallIdArb,
    })

    fc.assert(
      fc.property(
        authCombinationArb,
        ({ hasToken, hasApp, tokenValue, appIdValue, appKeyValue, appInstallIdValue }) => {
          const env: Record<string, string> = {
            GITHUB_WEBHOOK_SECRET: 'test-secret',
            KIRO_API_KEY: 'test-api-key',
            KIRO_CLI_PATH: '/bin/sh',
            BOT_USERNAME: 'rocky-bot',
            BRANCH_TEMPLATE: 'kiro/{issue_number}-{slug}',
          }

          if (hasToken) {
            env['GITHUB_TOKEN'] = tokenValue
          }
          if (hasApp) {
            env['GITHUB_APP_ID'] = appIdValue
            env['GITHUB_APP_PRIVATE_KEY'] = appKeyValue
            env['GITHUB_APP_INSTALLATION_ID'] = appInstallIdValue
          }

          if (!hasToken && !hasApp) {
            // Both absent → error (Zod validation failure)
            expect(() => parseConfig(env, { throwOnError: true })).toThrow(
              'Config validation failed',
            )
          } else {
            const config = parseConfig(env, { throwOnError: true })
            const mode = detectAuthMode(config)

            if (hasApp) {
              expect(mode).toBe('github-app')
            } else {
              expect(mode).toBe('pat')
            }

            if (hasToken) {
              expect(config.githubToken).toBe(tokenValue)
            } else {
              expect(config.githubToken).toBeUndefined()
            }

            if (hasApp) {
              expect(config.githubAppId).toBe(appIdValue)
              expect(config.githubAppPrivateKey).toBe(appKeyValue)
              expect(config.githubAppInstallationId).toBe(appInstallIdValue)
            } else {
              expect(config.githubAppId).toBeUndefined()
              expect(config.githubAppPrivateKey).toBeUndefined()
              expect(config.githubAppInstallationId).toBeUndefined()
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('both absent → error (validation failure)', () => {
    const env: Record<string, string> = {
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      KIRO_API_KEY: 'test-api-key',
      KIRO_CLI_PATH: '/bin/sh',
      BOT_USERNAME: 'rocky-bot',
      BRANCH_TEMPLATE: 'kiro/{issue_number}-{slug}',
    }

    expect(() => parseConfig(env, { throwOnError: true })).toThrow('Config validation failed')
  })

  it('token only → PAT mode', () => {
    const env = requiredEnv('pat')
    const config = parseConfig(env, { throwOnError: true })
    expect(detectAuthMode(config)).toBe('pat')
  })

  it('app trio only → GitHub App mode', () => {
    const env = requiredEnv('app')
    const config = parseConfig(env, { throwOnError: true })
    expect(detectAuthMode(config)).toBe('github-app')
  })

  it('both present → GitHub App mode (prefers app)', () => {
    const env = requiredEnv('both')
    const config = parseConfig(env, { throwOnError: true })
    expect(detectAuthMode(config)).toBe('github-app')
    expect(config.githubToken).toBeDefined()
    expect(config.githubAppId).toBeDefined()
  })

  it('detectAuthMode throws when neither auth is configured in WorkerConfig', () => {
    const config: WorkerConfig = {
      githubWebhookSecret: 'secret',
      kiroApiKey: 'key',
      kiroCliPath: '/bin/sh',
      botUsername: 'bot',
      port: 3000,
      webhookPath: '/webhook',
      triggerLabels: ['agent-action'],
      kiroTimeoutMs: 600_000,
      setupScriptTimeoutMs: 120_000,
      workingDirBase: '/tmp',
      logLevel: 'info',
      branchTemplate: 'kiro/{issue_number}-{slug}',
      allowedRepos: null,
      deniedRepos: null,
      a2aEnabled: true,
      a2aPath: '/a2a',
      mcpEnabled: true,
      mcpPath: '/mcp',
      defaultEngine: 'kiro',
      sessionLogEnabled: true,
      sessionLogDir: '/tmp/rocky-session-logs',
      sessionLogMaxFiles: 100,
      sessionLogMaxAgeHours: 168,
    }

    expect(() => detectAuthMode(config)).toThrow('No authentication configured')
  })
})

// ── Feature: rocky-copilot-cli-mode, Property 1: Copilot config parsing ──
// **Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.8**

describe('Property 1: Copilot config parsing preserves all new fields with correct defaults', () => {
  /**
   * Arbitrary for non-empty COPILOT_CLI_PATH values.
   * Uses /bin/sh as a base to pass the mocked executability check.
   */
  const copilotCliPathArb = fc
    .string({
      unit: fc.constantFrom('a', 'b', 'c', '/', '-', '_', '1', '2', '3'),
      minLength: 1,
      maxLength: 40,
    })
    .map((s) => `/usr/bin/${s}`)

  /** Arbitrary for non-empty COPILOT_GITHUB_TOKEN values. */
  const copilotGithubTokenArb = fc.string({
    unit: fc.constantFrom(
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'A',
      'B',
      'C',
      'D',
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
    maxLength: 60,
  })

  /** Arbitrary for DEFAULT_ENGINE values. */
  const defaultEngineArb = fc.constantFrom('kiro' as const, 'copilot' as const)

  /** Arbitrary for auth mode to vary the base required env. */
  const authModeArb = fc.constantFrom('pat' as const, 'app' as const)

  it('should preserve COPILOT_CLI_PATH, COPILOT_GITHUB_TOKEN, and DEFAULT_ENGINE when present, and use correct defaults when absent', () => {
    /**
     * Generate all combinations of presence/absence for the three Copilot env vars.
     * When DEFAULT_ENGINE is 'copilot', only COPILOT_CLI_PATH must be present
     * (cross-field validation). COPILOT_GITHUB_TOKEN is always optional.
     */
    const copilotConfigArb = fc
      .record({
        authMode: authModeArb,
        hasCopilotCliPath: fc.boolean(),
        copilotCliPath: copilotCliPathArb,
        hasCopilotGithubToken: fc.boolean(),
        copilotGithubToken: copilotGithubTokenArb,
        hasDefaultEngine: fc.boolean(),
        defaultEngine: defaultEngineArb,
      })
      .filter(({ hasCopilotCliPath, hasDefaultEngine, defaultEngine }) => {
        // When DEFAULT_ENGINE is 'copilot', only CLI path is required (token is optional)
        if (hasDefaultEngine && defaultEngine === 'copilot') {
          return hasCopilotCliPath
        }
        return true
      })

    fc.assert(
      fc.property(copilotConfigArb, (input) => {
        const env = { ...requiredEnv(input.authMode) }

        if (input.hasCopilotCliPath) {
          env['COPILOT_CLI_PATH'] = input.copilotCliPath
        }
        if (input.hasCopilotGithubToken) {
          env['COPILOT_GITHUB_TOKEN'] = input.copilotGithubToken
        }
        if (input.hasDefaultEngine) {
          env['DEFAULT_ENGINE'] = input.defaultEngine
        }

        const config = parseConfig(env, { throwOnError: true })

        // COPILOT_CLI_PATH: present → equals value; absent → undefined
        if (input.hasCopilotCliPath) {
          expect(config.copilotCliPath).toBe(input.copilotCliPath)
        } else {
          expect(config.copilotCliPath).toBeUndefined()
        }

        // COPILOT_GITHUB_TOKEN: present → equals value; absent → undefined
        if (input.hasCopilotGithubToken) {
          expect(config.copilotGithubToken).toBe(input.copilotGithubToken)
        } else {
          expect(config.copilotGithubToken).toBeUndefined()
        }

        // DEFAULT_ENGINE: present → equals value; absent → 'kiro'
        if (input.hasDefaultEngine) {
          expect(config.defaultEngine).toBe(input.defaultEngine)
        } else {
          expect(config.defaultEngine).toBe('kiro')
        }
      }),
      { numRuns: 100 },
    )
  })

  it('should parse successfully with DEFAULT_ENGINE=kiro regardless of COPILOT_CLI_PATH and COPILOT_GITHUB_TOKEN presence', () => {
    /**
     * When DEFAULT_ENGINE is 'kiro' (or absent), the config should parse
     * successfully regardless of whether COPILOT_CLI_PATH or COPILOT_GITHUB_TOKEN
     * are present. This validates Requirement 2.8.
     */
    const presenceArb = fc.record({
      authMode: authModeArb,
      hasCopilotCliPath: fc.boolean(),
      copilotCliPath: copilotCliPathArb,
      hasCopilotGithubToken: fc.boolean(),
      copilotGithubToken: copilotGithubTokenArb,
    })

    fc.assert(
      fc.property(presenceArb, (input) => {
        const env: Record<string, string> = {
          ...requiredEnv(input.authMode),
          DEFAULT_ENGINE: 'kiro',
        }

        if (input.hasCopilotCliPath) {
          env['COPILOT_CLI_PATH'] = input.copilotCliPath
        }
        if (input.hasCopilotGithubToken) {
          env['COPILOT_GITHUB_TOKEN'] = input.copilotGithubToken
        }

        // Should not throw — kiro mode doesn't require copilot vars
        const config = parseConfig(env, { throwOnError: true })
        expect(config.defaultEngine).toBe('kiro')
      }),
      { numRuns: 100 },
    )
  })

  it('should parse successfully with DEFAULT_ENGINE=copilot and COPILOT_CLI_PATH but without COPILOT_GITHUB_TOKEN', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      DEFAULT_ENGINE: 'copilot',
      COPILOT_CLI_PATH: '/usr/bin/copilot-cli',
    }

    const config = parseConfig(env, { throwOnError: true })

    expect(config.defaultEngine).toBe('copilot')
    expect(config.copilotCliPath).toBe('/usr/bin/copilot-cli')
    expect(config.copilotGithubToken).toBeUndefined()
  })

  it('should fail validation with DEFAULT_ENGINE=copilot when COPILOT_CLI_PATH is missing', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      DEFAULT_ENGINE: 'copilot',
    }

    expect(() => parseConfig(env, { throwOnError: true })).toThrow(
      /COPILOT_CLI_PATH is required when DEFAULT_ENGINE is "copilot"/,
    )
  })

  it('should parse successfully with DEFAULT_ENGINE=claude and CLAUDE_CLI_PATH', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      DEFAULT_ENGINE: 'claude',
      CLAUDE_CLI_PATH: '/usr/bin/claude',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    }

    const config = parseConfig(env, { throwOnError: true })

    expect(config.defaultEngine).toBe('claude')
    expect(config.claudeCliPath).toBe('/usr/bin/claude')
    expect(config.anthropicApiKey).toBe('sk-ant-test')
  })

  it('should fail validation with DEFAULT_ENGINE=claude when CLAUDE_CLI_PATH is missing', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      DEFAULT_ENGINE: 'claude',
    }

    expect(() => parseConfig(env, { throwOnError: true })).toThrow(
      /CLAUDE_CLI_PATH is required when DEFAULT_ENGINE is "claude"/,
    )
  })
})

// ── Property 1: Config parsing preserves GITHUB_API_KEY ──
// Feature: github-api-key-clone-auth, Property 1: Config parsing preserves GITHUB_API_KEY
// **Validates: Requirements 1.1, 1.2, 1.3**

describe('Property 1: Config parsing preserves GITHUB_API_KEY', () => {
  /**
   * Arbitrary for non-empty GITHUB_API_KEY values.
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

  it('should preserve GITHUB_API_KEY when present and return undefined when absent', () => {
    const authModeArb = fc.constantFrom('pat' as const, 'app' as const)
    const apiKeyPresenceArb = fc.oneof(
      apiKeyArb.map((key) => ({ present: true as const, value: key })),
      fc.constant({ present: false as const, value: undefined as string | undefined }),
    )

    fc.assert(
      fc.property(authModeArb, apiKeyPresenceArb, (authMode, apiKeyOption) => {
        const env = { ...requiredEnv(authMode) }

        if (apiKeyOption.present) {
          env['GITHUB_API_KEY'] = apiKeyOption.value!
        }

        const config = parseConfig(env, { throwOnError: true })

        if (apiKeyOption.present) {
          expect(config.githubApiKey).toBe(apiKeyOption.value)
        } else {
          expect(config.githubApiKey).toBeUndefined()
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ── Unit test: Config schema rejects empty GITHUB_API_KEY ──
// Feature: github-api-key-clone-auth
// **Validates: Requirements 1.2**

describe('Config schema rejects empty GITHUB_API_KEY', () => {
  it('should treat GITHUB_API_KEY="" as absent (githubApiKey is undefined)', () => {
    const env = { ...requiredEnv('pat'), GITHUB_API_KEY: '' }
    const config = parseConfig(env, { throwOnError: true })

    expect(config.githubApiKey).toBeUndefined()
  })
})

// ── Property 8: MCP config defaults are applied for absent optional variables ──
// **Validates: Requirements 12.5**

describe('Property 8: MCP config defaults are applied for absent optional variables', () => {
  /**
   * Arbitrary that generates a valid set of required env vars (using either PAT
   * or App auth) but never includes MCP_ENABLED, MCP_PATH, or MCP_AUTH_TOKEN.
   * Other optional vars may be present or absent — the property only cares about
   * the three MCP fields.
   */
  const requiredEnvArb = fc.constantFrom('pat' as const, 'app' as const).map((mode) => {
    const env = requiredEnv(mode)
    // Ensure no MCP vars leak in
    delete env['MCP_ENABLED']
    delete env['MCP_PATH']
    delete env['MCP_AUTH_TOKEN']
    return env
  })

  /**
   * Arbitrary for extra non-MCP optional vars that may be sprinkled in.
   * This ensures the property holds regardless of what other optional vars are present.
   */
  const extraOptionalVarsArb = fc
    .subarray(
      [
        { key: 'PORT', value: '8080' },
        { key: 'WEBHOOK_PATH', value: '/hooks' },
        { key: 'TRIGGER_LABELS', value: 'label-a' },
        { key: 'KIRO_TIMEOUT_MS', value: '300000' },
        { key: 'SETUP_SCRIPT_TIMEOUT_MS', value: '60000' },
        { key: 'WORKING_DIR_BASE', value: '/tmp/test' },
        { key: 'LOG_LEVEL', value: 'debug' },
      ],
      { minLength: 0, maxLength: 7 },
    )
    .map((entries) => Object.fromEntries(entries.map((e) => [e.key, e.value])))

  it('should apply MCP defaults (mcpEnabled=true, mcpPath="/mcp", mcpAuthToken=undefined) when MCP env vars are absent', () => {
    fc.assert(
      fc.property(requiredEnvArb, extraOptionalVarsArb, (base, extras) => {
        const env = { ...base, ...extras }

        const config = parseConfig(env, { throwOnError: true })

        expect(config.mcpEnabled).toBe(true)
        expect(config.mcpPath).toBe('/mcp')
        expect(config.mcpAuthToken).toBeUndefined()
      }),
      { numRuns: 100 },
    )
  })
})

// ── Property 9: A2A config defaults are applied for absent optional variables ──
// **Validates: Requirements 10.5**

describe('Property 9: A2A config defaults are applied for absent optional variables', () => {
  /**
   * Arbitrary that generates a valid set of required env vars (using either PAT
   * or App auth) but never includes A2A_ENABLED, A2A_PATH, or A2A_AUTH_TOKEN.
   * Other optional vars may be present or absent — the property only cares about
   * the three A2A fields.
   */
  const requiredEnvArb = fc.constantFrom('pat' as const, 'app' as const).map((mode) => {
    const env = requiredEnv(mode)
    // Ensure no A2A vars leak in
    delete env['A2A_ENABLED']
    delete env['A2A_PATH']
    delete env['A2A_AUTH_TOKEN']
    return env
  })

  /**
   * Arbitrary for extra non-A2A optional vars that may be sprinkled in.
   * This ensures the property holds regardless of what other optional vars are present.
   */
  const extraOptionalVarsArb = fc
    .subarray(
      [
        { key: 'PORT', value: '8080' },
        { key: 'WEBHOOK_PATH', value: '/hooks' },
        { key: 'TRIGGER_LABELS', value: 'label-a' },
        { key: 'KIRO_TIMEOUT_MS', value: '300000' },
        { key: 'SETUP_SCRIPT_TIMEOUT_MS', value: '60000' },
        { key: 'WORKING_DIR_BASE', value: '/tmp/test' },
        { key: 'LOG_LEVEL', value: 'debug' },
      ],
      { minLength: 0, maxLength: 7 },
    )
    .map((entries) => Object.fromEntries(entries.map((e) => [e.key, e.value])))

  it('should apply A2A defaults (a2aEnabled=true, a2aPath="/a2a", a2aAuthToken=undefined) when A2A env vars are absent', () => {
    fc.assert(
      fc.property(requiredEnvArb, extraOptionalVarsArb, (base, extras) => {
        const env = { ...base, ...extras }

        const config = parseConfig(env, { throwOnError: true })

        expect(config.a2aEnabled).toBe(true)
        expect(config.a2aPath).toBe('/a2a')
        expect(config.a2aAuthToken).toBeUndefined()
      }),
      { numRuns: 100 },
    )
  })
})

// ── Feature: worker-observability, Property 4: Session log config parsing with defaults ──
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.5, 4.6, 8.1, 8.2, 8.3**

describe('Property 4: Session log config parsing with defaults', () => {
  /**
   * Arbitrary for boolean-coercible SESSION_LOG_ENABLED values.
   * The schema uses a string transform: "false" and "0" → false, everything else → true.
   * This matches operator expectations for env var boolean configuration.
   */
  const sessionLogEnabledArb = fc.constantFrom(
    { envValue: 'true', expected: true },
    { envValue: '1', expected: true },
    { envValue: 'yes', expected: true },
    { envValue: 'false', expected: false },
    { envValue: 'FALSE', expected: false },
    { envValue: '0', expected: false },
  )

  /** Arbitrary for non-empty SESSION_LOG_DIR values. */
  const sessionLogDirArb = fc
    .string({
      unit: fc.constantFrom('a', 'b', 'c', '/', '-', '_', '1', '2', '3'),
      minLength: 1,
      maxLength: 40,
    })
    .map((s) => `/var/logs/${s}`)

  /** Arbitrary for positive integer SESSION_LOG_MAX_FILES values. */
  const sessionLogMaxFilesArb = fc.integer({ min: 1, max: 10000 }).map(String)

  /** Arbitrary for positive integer SESSION_LOG_MAX_AGE_HOURS values. */
  const sessionLogMaxAgeHoursArb = fc.integer({ min: 1, max: 8760 }).map(String)

  /** Arbitrary for auth mode to vary the base required env. */
  const authModeArb = fc.constantFrom('pat' as const, 'app' as const)

  it('should preserve session log config values when present and apply defaults when absent', () => {
    const sessionLogConfigArb = fc.record({
      authMode: authModeArb,
      hasSessionLogEnabled: fc.boolean(),
      sessionLogEnabled: sessionLogEnabledArb,
      hasSessionLogDir: fc.boolean(),
      sessionLogDir: sessionLogDirArb,
      hasSessionLogMaxFiles: fc.boolean(),
      sessionLogMaxFiles: sessionLogMaxFilesArb,
      hasSessionLogMaxAgeHours: fc.boolean(),
      sessionLogMaxAgeHours: sessionLogMaxAgeHoursArb,
    })

    fc.assert(
      fc.property(sessionLogConfigArb, (input) => {
        const env = { ...requiredEnv(input.authMode) }

        if (input.hasSessionLogEnabled) {
          env['SESSION_LOG_ENABLED'] = input.sessionLogEnabled.envValue
        }
        if (input.hasSessionLogDir) {
          env['SESSION_LOG_DIR'] = input.sessionLogDir
        }
        if (input.hasSessionLogMaxFiles) {
          env['SESSION_LOG_MAX_FILES'] = input.sessionLogMaxFiles
        }
        if (input.hasSessionLogMaxAgeHours) {
          env['SESSION_LOG_MAX_AGE_HOURS'] = input.sessionLogMaxAgeHours
        }

        const config = parseConfig(env, { throwOnError: true })

        // (a) sessionLogEnabled: present → coerced boolean; absent → true
        if (input.hasSessionLogEnabled) {
          expect(config.sessionLogEnabled).toBe(input.sessionLogEnabled.expected)
        } else {
          expect(config.sessionLogEnabled).toBe(true)
        }

        // (b) sessionLogDir: present → equals value; absent → ./logs/sessions
        if (input.hasSessionLogDir) {
          expect(config.sessionLogDir).toBe(input.sessionLogDir)
        } else {
          expect(config.sessionLogDir).toBe('./logs/sessions')
        }

        // (c) sessionLogMaxFiles: present → equals integer; absent → 100
        if (input.hasSessionLogMaxFiles) {
          expect(config.sessionLogMaxFiles).toBe(parseInt(input.sessionLogMaxFiles, 10))
        } else {
          expect(config.sessionLogMaxFiles).toBe(100)
        }

        // (d) sessionLogMaxAgeHours: present → equals integer; absent → 168
        if (input.hasSessionLogMaxAgeHours) {
          expect(config.sessionLogMaxAgeHours).toBe(parseInt(input.sessionLogMaxAgeHours, 10))
        } else {
          expect(config.sessionLogMaxAgeHours).toBe(168)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('should apply all session log defaults when no session log env vars are set', () => {
    const env = requiredEnv('pat')
    const config = parseConfig(env, { throwOnError: true })

    expect(config.sessionLogEnabled).toBe(true)
    expect(config.sessionLogDir).toBe('./logs/sessions')
    expect(config.sessionLogMaxFiles).toBe(100)
    expect(config.sessionLogMaxAgeHours).toBe(168)
  })

  it('should use provided values when all session log env vars are set', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      SESSION_LOG_ENABLED: 'false',
      SESSION_LOG_DIR: '/custom/logs/sessions',
      SESSION_LOG_MAX_FILES: '50',
      SESSION_LOG_MAX_AGE_HOURS: '72',
    }

    const config = parseConfig(env, { throwOnError: true })

    expect(config.sessionLogEnabled).toBe(false)
    expect(config.sessionLogDir).toBe('/custom/logs/sessions')
    expect(config.sessionLogMaxFiles).toBe(50)
    expect(config.sessionLogMaxAgeHours).toBe(72)
  })

  it('should default sessionLogDir to ./logs/sessions when SESSION_LOG_DIR is absent', () => {
    const env: Record<string, string> = {
      ...requiredEnv('pat'),
      WORKING_DIR_BASE: '/my/working/dir',
    }

    const config = parseConfig(env, { throwOnError: true })

    expect(config.sessionLogDir).toBe('./logs/sessions')
  })
})
