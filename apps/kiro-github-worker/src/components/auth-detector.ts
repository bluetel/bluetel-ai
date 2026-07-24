/**
 * Auth detector for determining the GitHub authentication mode at startup.
 *
 * Checks environment configuration to select between GitHub App mode
 * (preferred) and PAT mode (fallback). Provides an authenticated Octokit
 * instance and a `getToken()` function for git clone auth.
 *
 * - GitHub App mode: uses `@octokit/auth-app` with `createAppAuth` for
 *   auto-rotating Installation Tokens.
 * - PAT mode: validates token scopes with a test API call and logs
 *   warnings for insufficient permissions.
 */

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import type pino from 'pino'

import type { AuthResult, WorkerConfig } from '../lib/types'

// ── PEM Validation ──────────────────────────────────────────────────

const PEM_HEADER = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_FOOTER = '-----END RSA PRIVATE KEY-----'
const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----'
const PKCS8_FOOTER = '-----END PRIVATE KEY-----'

/**
 * Validates that a string looks like a PEM-encoded private key.
 * Accepts both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats.
 */
const isValidPemKey = (key: string): boolean => {
  const trimmed = key.trim()
  return (
    (trimmed.startsWith(PEM_HEADER) && trimmed.endsWith(PEM_FOOTER)) ||
    (trimmed.startsWith(PKCS8_HEADER) && trimmed.endsWith(PKCS8_FOOTER))
  )
}

// ── Required PAT Scopes ─────────────────────────────────────────────

const REQUIRED_SCOPES = ['repo']

// ── Auth Detection ──────────────────────────────────────────────────

/**
 * Detects the authentication mode from the parsed WorkerConfig and returns
 * an `AuthResult` with an authenticated Octokit instance, the bot username,
 * and a `getToken()` function for git clone auth.
 *
 * Behavior:
 * - If `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`
 *   are all present → GitHub App mode.
 * - Falls back to `GITHUB_TOKEN` → PAT mode.
 * - If both present → prefers App mode, logs warning.
 * - If neither → logs error, exits process.
 *
 * In App mode: validates PEM key format at startup, uses `createAppAuth`
 * for auto-rotating Installation Tokens.
 *
 * In PAT mode: validates token scopes with a test API call, logs warning
 * if insufficient.
 *
 * @param config - Parsed WorkerConfig
 * @param logger - Pino logger instance
 * @returns AuthResult with mode, octokit, botUsername, and getToken()
 */
export const detectAuth = async (
  config: WorkerConfig,
  logger: pino.Logger,
): Promise<AuthResult> => {
  const hasAppAuth =
    config.githubAppId != null &&
    config.githubAppPrivateKey != null &&
    config.githubAppInstallationId != null

  const hasToken = config.githubToken != null

  // Neither auth method configured → fatal error
  if (!hasAppAuth && !hasToken) {
    logger.error(
      'No authentication configured. Provide either GITHUB_TOKEN or the GitHub App trio (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID).',
    )
    process.exit(1)
  }

  // Both present → prefer App mode, warn about redundant PAT
  if (hasAppAuth && hasToken) {
    logger.warn(
      'Both GITHUB_TOKEN and GitHub App credentials are configured. Preferring GitHub App mode; GITHUB_TOKEN will be ignored.',
    )
  }

  const authResult = hasAppAuth
    ? await setupGitHubAppAuth(config, logger)
    : await setupPatAuth(config, logger)

  if (config.githubApiKey != null) {
    logger.info('Clone operations will use dedicated GITHUB_API_KEY')
  } else {
    logger.debug('Clone operations will use Auth_Detector-provided token')
  }

  return authResult
}

// ── GitHub App Auth ─────────────────────────────────────────────────

const setupGitHubAppAuth = async (
  config: WorkerConfig,
  logger: pino.Logger,
): Promise<AuthResult> => {
  // These are guaranteed non-null because detectAuth only calls this when hasAppAuth is true
  const appId = config.githubAppId as string
  const privateKey = config.githubAppPrivateKey as string
  const installationId = config.githubAppInstallationId as string

  // Validate PEM key format at startup
  if (!isValidPemKey(privateKey)) {
    logger.error(
      'GITHUB_APP_PRIVATE_KEY is not a valid PEM-encoded private key. Expected a key starting with "-----BEGIN RSA PRIVATE KEY-----" or "-----BEGIN PRIVATE KEY-----".',
    )
    process.exit(1)
  }

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  })

  // Verify we can generate an installation token
  try {
    await auth({ type: 'installation' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      { error: message },
      'Failed to generate GitHub App installation token. Verify GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID are correct.',
    )
    process.exit(1)
  }

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  })

  // Use the configured BOT_USERNAME as-is — no automatic [bot] suffix.
  // The user controls the exact mention string via the BOT_USERNAME env var.
  const botUsername = config.botUsername

  logger.info(
    { mode: 'github-app', appId, installationId },
    'Authentication active: GitHub App mode',
  )

  const getToken = async (): Promise<string> => {
    // createAppAuth handles token caching and auto-refresh
    const tokenAuth = await auth({ type: 'installation' })
    return tokenAuth.token
  }

  const getCloneToken =
    config.githubApiKey != null
      ? (): Promise<string> => Promise.resolve(config.githubApiKey as string)
      : getToken

  return {
    mode: 'github-app',
    octokit,
    botUsername,
    getToken,
    getCloneToken,
  }
}

// ── PAT Auth ────────────────────────────────────────────────────────

const setupPatAuth = async (config: WorkerConfig, logger: pino.Logger): Promise<AuthResult> => {
  const token = config.githubToken as string

  const octokit = new Octokit({ auth: token })

  // Validate token scopes with a test API call
  try {
    const response = await octokit.rest.users.getAuthenticated()
    const scopesHeader = response.headers['x-oauth-scopes']
    const scopesStr = typeof scopesHeader === 'string' ? scopesHeader : ''
    const scopes = scopesStr
      ? scopesStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    const missingScopes = REQUIRED_SCOPES.filter((required) => !scopes.includes(required))

    if (missingScopes.length > 0) {
      logger.warn(
        { missingScopes, currentScopes: scopes },
        `GITHUB_TOKEN may have insufficient scopes. Missing: ${missingScopes.join(', ')}. Required: ${REQUIRED_SCOPES.join(', ')}.`,
      )
    } else {
      logger.debug({ scopes }, 'GITHUB_TOKEN scopes validated')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      { error: message },
      'Could not validate GITHUB_TOKEN scopes. The token may be invalid or have restricted access.',
    )
  }

  logger.info({ mode: 'pat' }, 'Authentication active: PAT mode')

  const getToken = (): Promise<string> => Promise.resolve(token)

  const getCloneToken =
    config.githubApiKey != null
      ? (): Promise<string> => Promise.resolve(config.githubApiKey as string)
      : getToken

  return {
    mode: 'pat',
    octokit,
    botUsername: config.botUsername,
    getToken,
    getCloneToken,
  }
}
