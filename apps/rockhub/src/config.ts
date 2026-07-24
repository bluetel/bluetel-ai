import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import { z } from 'zod'

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Decodes a base64-encoded PEM key if the value does not already start
 * with `-----BEGIN`. Allows safe storage of multi-line PEM keys in
 * environment variables and `.env` files without escaping newlines.
 */
const decodeBase64IfNotPem = (val: string): string => {
  const trimmed = val.trim()
  if (trimmed.startsWith('-----BEGIN')) {
    return trimmed
  }
  return Buffer.from(trimmed, 'base64').toString('utf-8')
}

/**
 * Transforms a comma-separated string into a trimmed, non-empty array.
 * Used for `ALLOWED_REPOS` and `DENIED_REPOS`.
 */
const commaSeparatedList = z
  .string()
  .transform((val) =>
    val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)).min(1))

// ── Zod Schema ──────────────────────────────────────────────────────

const configSchema = z.object({
  // Required
  GITHUB_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
  GITHUB_APP_ID: z.string().min(1, 'GITHUB_APP_ID is required'),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(1, 'GITHUB_APP_PRIVATE_KEY is required')
    .transform(decodeBase64IfNotPem),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1, 'GITHUB_APP_INSTALLATION_ID is required'),
  BOT_USERNAME: z.string().min(1, 'BOT_USERNAME is required'),
  OPENCLAW_CLI_PATH: z.string().min(1, 'OPENCLAW_CLI_PATH is required'),

  // Optional with defaults
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  WEBHOOK_PATH: z.string().min(1).default('/webhook'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ALLOWED_REPOS: commaSeparatedList.optional(),
  DENIED_REPOS: commaSeparatedList.optional(),
  OPENCLAW_SUBCOMMAND: z.string().min(1).default('agent --local --message'),
  OPENCLAW_PAYLOAD_TRANSPORT: z.enum(['stdin', 'argv', 'env', 'file']).default('stdin'),
  OPENCLAW_LOG_DIR: z.string().min(1).default('./logs/openclaw'),
})

export { configSchema }

// ── Config Type ─────────────────────────────────────────────────────

export interface RockhubConfig {
  githubWebhookSecret: string
  githubAppId: string
  githubAppPrivateKey: string
  githubAppInstallationId: string
  botUsername: string
  openclawCliPath: string

  port: number
  webhookPath: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  allowedRepos: string[] | null
  deniedRepos: string[] | null
  openclawSubCommand: string
  openclawPayloadTransport: 'stdin' | 'argv' | 'env' | 'file'
  openclawLogDir: string
}

// ── .env.local Loader ───────────────────────────────────────────────

/**
 * Loads `.env.local` files from the app root and workspace root.
 * Workspace root values take precedence over app-level values.
 */
export const loadEnvFiles = (): void => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const projectRoot = path.resolve(__dirname, '..')
  const workspaceRoot = path.resolve(projectRoot, '../..')

  // Load app-level first (does not override existing process.env)
  dotenv.config({ path: path.join(projectRoot, '.env.local') })
  // Load workspace root with override so it takes precedence over app-level
  dotenv.config({ path: path.join(workspaceRoot, '.env.local'), override: true })
}

// ── Config Parser ───────────────────────────────────────────────────

/**
 * Parses and validates environment variables into a fully typed RockhubConfig.
 *
 * @param env - Environment variables object (defaults to process.env)
 * @param options - `throwOnError` to throw instead of calling process.exit(1)
 * @returns A validated RockhubConfig object
 */
export const parseConfig = (
  env: Record<string, string | undefined> = process.env,
  options: { throwOnError?: boolean } = {},
): RockhubConfig => {
  // Strip undefined/empty values so Zod defaults kick in for missing keys
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

  // Post-parse validation: OPENCLAW_CLI_PATH must be executable
  try {
    fs.accessSync(data.OPENCLAW_CLI_PATH, fs.constants.X_OK)
  } catch {
    const msg = `OPENCLAW_CLI_PATH "${data.OPENCLAW_CLI_PATH}" is not an executable file`
    if (options.throwOnError) {
      throw new Error(msg)
    }
    console.error(`[config] Error: ${msg}`)
    process.exit(1)
  }

  return {
    githubWebhookSecret: data.GITHUB_WEBHOOK_SECRET,
    githubAppId: data.GITHUB_APP_ID,
    githubAppPrivateKey: data.GITHUB_APP_PRIVATE_KEY,
    githubAppInstallationId: data.GITHUB_APP_INSTALLATION_ID,
    botUsername: data.BOT_USERNAME,
    openclawCliPath: data.OPENCLAW_CLI_PATH,

    port: data.PORT,
    webhookPath: data.WEBHOOK_PATH,
    logLevel: data.LOG_LEVEL,
    allowedRepos: data.ALLOWED_REPOS ?? null,
    deniedRepos: data.DENIED_REPOS ?? null,
    openclawSubCommand: data.OPENCLAW_SUBCOMMAND,
    openclawPayloadTransport: data.OPENCLAW_PAYLOAD_TRANSPORT,
    openclawLogDir: data.OPENCLAW_LOG_DIR,
  }
}
