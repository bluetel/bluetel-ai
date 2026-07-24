// TODO: test edit to verify Kiro hooks are working
import fs from 'node:fs'
import os from 'node:os'

import { z } from 'zod'

import type { AuthMode, WorkerConfig } from './lib/types'

// Test edit to verify Kiro hooks — safe to remove
const _hookTest = 'hooks-working' as const
void _hookTest

// ── Zod Schemas ─────────────────────────────────────────────────────

/** Transforms a comma-separated string into a trimmed, non-empty array or null. */
const commaSeparatedList = z
  .string()
  .transform((val) =>
    val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)).min(1))

const branchTemplateSchema = z.string().superRefine((val, ctx) => {
  if (val.includes(' ')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch template must not contain spaces',
    })
  }
  if (val.includes('..')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Branch template must not contain ".."' })
  }
  if (val.endsWith('.lock')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch template must not end with ".lock"',
    })
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch template must not contain control characters',
    })
  }
})

const configSchema = z
  .object({
    // Required
    GITHUB_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
    KIRO_API_KEY: z.string().min(1, 'KIRO_API_KEY is required'),
    KIRO_CLI_PATH: z.string().min(1, 'KIRO_CLI_PATH is required'),
    BOT_USERNAME: z.string().min(1, 'BOT_USERNAME is required'),

    // Auth
    GITHUB_TOKEN: z.string().min(1).optional(),
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((val) => {
        // Accept base64-encoded PEM keys — decode them transparently
        const trimmed = val.trim()
        if (
          trimmed.startsWith('-----BEGIN') ||
          trimmed.startsWith('-----BEGIN RSA PRIVATE KEY-----') ||
          trimmed.startsWith('-----BEGIN PRIVATE KEY-----')
        ) {
          // Already a raw PEM string
          return trimmed
        }
        // Assume base64-encoded — decode to UTF-8
        return Buffer.from(trimmed, 'base64').toString('utf-8')
      })
      .optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().min(1).optional(),

    // Optional with defaults
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    WEBHOOK_PATH: z.string().min(1).default('/webhook'),
    TRIGGER_LABELS: z
      .string()
      .transform((val) =>
        val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().min(1)).min(1))
      .default('agent-action'),
    KIRO_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    SETUP_SCRIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    WORKING_DIR_BASE: z.string().min(1).default(os.tmpdir()),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    BRANCH_TEMPLATE: z.string().min(1, 'BRANCH_TEMPLATE is required').pipe(branchTemplateSchema),

    // A2A configuration
    A2A_ENABLED: z.coerce.boolean().default(true),
    A2A_PATH: z.string().min(1).default('/a2a'),
    A2A_AUTH_TOKEN: z.string().min(1).optional(),

    // MCP configuration
    MCP_ENABLED: z.coerce.boolean().default(true),
    MCP_PATH: z.string().min(1).default('/mcp'),
    MCP_AUTH_TOKEN: z.string().min(1).optional(),

    // Clone authentication
    GITHUB_API_KEY: z.string().min(1).optional(),

    // Copilot CLI configuration
    COPILOT_CLI_PATH: z.string().min(1).optional(),
    COPILOT_GITHUB_TOKEN: z.string().min(1).optional(),

    // Claude Code CLI configuration
    CLAUDE_CLI_PATH: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),

    DEFAULT_ENGINE: z.enum(['kiro', 'copilot', 'claude']).default('kiro'),

    // Agent selection
    DEFAULT_AGENT: z.string().min(1).optional(),

    // Session logging configuration
    SESSION_LOG_ENABLED: z
      .string()
      .transform((val) => val.toLowerCase() !== 'false' && val !== '0')
      .default('true'),
    SESSION_LOG_DIR: z.string().min(1).optional(),
    SESSION_LOG_MAX_FILES: z.coerce.number().int().positive().default(100),
    SESSION_LOG_MAX_AGE_HOURS: z.coerce.number().int().positive().default(168),

    // Admin dashboard configuration
    ADMIN_API_TOKEN: z.string().min(1).optional(),
    ADMIN_DASHBOARD_TOKEN: z.string().min(1).optional(),

    // Optional repo filters
    ALLOWED_REPOS: commaSeparatedList.optional(),
    DENIED_REPOS: commaSeparatedList.optional(),
  })
  .superRefine((data, ctx) => {
    const hasToken = data.GITHUB_TOKEN != null
    const hasAppId = data.GITHUB_APP_ID != null
    const hasAppKey = data.GITHUB_APP_PRIVATE_KEY != null
    const hasAppInstall = data.GITHUB_APP_INSTALLATION_ID != null
    const hasFullApp = hasAppId && hasAppKey && hasAppInstall
    const hasPartialApp = (hasAppId || hasAppKey || hasAppInstall) && !hasFullApp

    if (!hasToken && !hasFullApp) {
      if (hasPartialApp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Incomplete GitHub App configuration. All three variables are required: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID',
        })
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'No authentication configured. Provide either GITHUB_TOKEN or the GitHub App trio (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID)',
        })
      }
    }

    // When DEFAULT_ENGINE is 'copilot', require COPILOT_CLI_PATH
    if (data.DEFAULT_ENGINE === 'copilot') {
      if (data.COPILOT_CLI_PATH == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'COPILOT_CLI_PATH is required when DEFAULT_ENGINE is "copilot"',
        })
      }
    }

    // When DEFAULT_ENGINE is 'claude', require CLAUDE_CLI_PATH
    if (data.DEFAULT_ENGINE === 'claude') {
      if (data.CLAUDE_CLI_PATH == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CLAUDE_CLI_PATH is required when DEFAULT_ENGINE is "claude"',
        })
      }
    }
  })

export { configSchema }

// ── Auth Mode Detection ─────────────────────────────────────────────

/**
 * Determines the authentication mode based on the parsed config.
 *
 * - If all three GitHub App variables are present → 'github-app'
 * - If only GITHUB_TOKEN is present → 'pat'
 * - Throws if neither is configured
 */
export const detectAuthMode = (config: WorkerConfig): AuthMode => {
  const hasAppAuth =
    config.githubAppId != null &&
    config.githubAppPrivateKey != null &&
    config.githubAppInstallationId != null

  if (hasAppAuth) {
    return 'github-app'
  }

  if (config.githubToken != null) {
    return 'pat'
  }

  throw new Error(
    'No authentication configured. Provide either GITHUB_TOKEN or the GitHub App trio (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID).',
  )
}

// ── Config Parser ───────────────────────────────────────────────────

/**
 * Parses and validates environment variables into a fully typed WorkerConfig
 * using Zod schemas.
 *
 * @param env - Environment variables object (defaults to process.env for production,
 *              accepts a custom object for testing)
 * @returns A validated WorkerConfig object
 * @throws {ZodError} if validation fails (in test usage)
 * @exits process with code 1 if validation fails (in production usage — set `throwOnError` to override)
 */
export const parseConfig = (
  env: Record<string, string | undefined> = process.env,
  options: { throwOnError?: boolean } = {},
): WorkerConfig => {
  // Strip undefined values so Zod defaults kick in for missing keys
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value != null && value !== '') {
      cleaned[key] = value
    }
  }

  const result = configSchema.safeParse(cleaned)

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
      return `${path}${issue.message}`
    })

    if (options.throwOnError) {
      throw new Error(`Config validation failed:\n${messages.join('\n')}`)
    }

    for (const msg of messages) {
      console.error(`[config] Error: ${msg}`)
    }
    process.exit(1)
  }

  const data = result.data

  // Warn if branch template lacks {issue_number}
  if (!data.BRANCH_TEMPLATE.includes('{issue_number}')) {
    console.warn(
      '[config] Warning: Branch template does not contain {issue_number} — issue-to-branch mapping will rely solely on the Branch_Map',
    )
  }

  // Validate KIRO_CLI_PATH executability
  try {
    fs.accessSync(data.KIRO_CLI_PATH, fs.constants.X_OK)
  } catch {
    const msg = `KIRO_CLI_PATH "${data.KIRO_CLI_PATH}" is not an executable file`
    if (options.throwOnError) {
      throw new Error(msg)
    }
    console.error(`[config] Error: ${msg}`)
    process.exit(1)
  }

  // Validate COPILOT_CLI_PATH executability (when configured)
  if (data.COPILOT_CLI_PATH != null) {
    try {
      fs.accessSync(data.COPILOT_CLI_PATH, fs.constants.X_OK)
    } catch {
      const msg = `COPILOT_CLI_PATH "${data.COPILOT_CLI_PATH}" is not an executable file`
      if (options.throwOnError) {
        throw new Error(msg)
      }
      console.error(`[config] Error: ${msg}`)
      process.exit(1)
    }
  }

  // Validate CLAUDE_CLI_PATH executability (when configured)
  if (data.CLAUDE_CLI_PATH != null) {
    try {
      fs.accessSync(data.CLAUDE_CLI_PATH, fs.constants.X_OK)
    } catch {
      const msg = `CLAUDE_CLI_PATH "${data.CLAUDE_CLI_PATH}" is not an executable file`
      if (options.throwOnError) {
        throw new Error(msg)
      }
      console.error(`[config] Error: ${msg}`)
      process.exit(1)
    }
  }

  return {
    githubWebhookSecret: data.GITHUB_WEBHOOK_SECRET,
    kiroApiKey: data.KIRO_API_KEY,
    kiroCliPath: data.KIRO_CLI_PATH,
    botUsername: data.BOT_USERNAME,

    githubToken: data.GITHUB_TOKEN,
    githubAppId: data.GITHUB_APP_ID,
    githubAppPrivateKey: data.GITHUB_APP_PRIVATE_KEY,
    githubAppInstallationId: data.GITHUB_APP_INSTALLATION_ID,
    githubApiKey: data.GITHUB_API_KEY,

    port: data.PORT,
    webhookPath: data.WEBHOOK_PATH,
    triggerLabels: data.TRIGGER_LABELS,
    kiroTimeoutMs: data.KIRO_TIMEOUT_MS,
    setupScriptTimeoutMs: data.SETUP_SCRIPT_TIMEOUT_MS,
    workingDirBase: data.WORKING_DIR_BASE,
    logLevel: data.LOG_LEVEL,
    branchTemplate: data.BRANCH_TEMPLATE,

    allowedRepos: data.ALLOWED_REPOS ?? null,
    deniedRepos: data.DENIED_REPOS ?? null,

    // A2A configuration
    a2aEnabled: data.A2A_ENABLED,
    a2aPath: data.A2A_PATH,
    a2aAuthToken: data.A2A_AUTH_TOKEN,

    // MCP configuration
    mcpEnabled: data.MCP_ENABLED,
    mcpPath: data.MCP_PATH,
    mcpAuthToken: data.MCP_AUTH_TOKEN,

    // Copilot CLI configuration
    copilotCliPath: data.COPILOT_CLI_PATH,
    copilotGithubToken: data.COPILOT_GITHUB_TOKEN,

    // Claude Code CLI configuration
    claudeCliPath: data.CLAUDE_CLI_PATH,
    anthropicApiKey: data.ANTHROPIC_API_KEY,

    defaultEngine: data.DEFAULT_ENGINE,

    // Agent selection
    defaultAgent: data.DEFAULT_AGENT,

    // Session logging configuration
    sessionLogEnabled: data.SESSION_LOG_ENABLED,
    sessionLogDir: data.SESSION_LOG_DIR ?? './logs/sessions',
    sessionLogMaxFiles: data.SESSION_LOG_MAX_FILES,
    sessionLogMaxAgeHours: data.SESSION_LOG_MAX_AGE_HOURS,

    // Admin dashboard configuration
    adminApiToken: data.ADMIN_API_TOKEN,
    adminDashboardToken: data.ADMIN_DASHBOARD_TOKEN,
  }
}
