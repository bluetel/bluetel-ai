/**
 * Auth component for Rockhub.
 *
 * Wraps `@octokit/auth-app` to produce an authenticated Octokit instance
 * using a GitHub App Installation Token. Only GitHub App mode is supported
 * (no PAT fallback per Req 8.5).
 *
 * At startup, mints an installation token once to verify configuration.
 * If minting fails, logs an error and exits the process (Req 11.5).
 */

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import type pino from 'pino'

// ── Public Interface ────────────────────────────────────────────────

export interface AuthConfig {
  appId: string
  privateKey: string
  installationId: string
}

export interface AuthInstance {
  octokit: Octokit
  /** Returns a fresh installation token (auto-rotated by auth-app). */
  getToken: () => Promise<string>
  /** The GitHub App's bot login, e.g. "my-app-slug[bot]". Derived from GET /app at startup. */
  appBotLogin: string
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates an authenticated Octokit instance backed by a GitHub App
 * Installation Token. Mints a token at startup to verify credentials;
 * on failure logs at `error` level and exits with code 1.
 *
 * The returned `getToken()` delegates to `@octokit/auth-app`'s built-in
 * token caching and auto-rotation — callers always receive a valid token.
 */
export const createAuth = async (
  config: AuthConfig,
  logger: pino.Logger,
): Promise<AuthInstance> => {
  const { appId, privateKey, installationId } = config

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  })

  // Mint an installation token at startup to verify configuration (Req 8.4)
  try {
    await auth({ type: 'installation' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      { error: message, appId, installationId },
      'Failed to mint GitHub App installation token. Verify GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.',
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

  // Retrieve the App's slug via GET /app to derive appBotLogin (Req 18.5, 18.6)
  let appBotLogin: string
  try {
    const { data: appData } = await octokit.apps.getAuthenticated()
    if (!appData?.slug) {
      throw new Error('GET /app response missing slug field')
    }
    appBotLogin = `${appData.slug}[bot]`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      { error: message, appId },
      'Failed to retrieve GitHub App identity via GET /app. The appBotLogin is required for dual-identity reaction checks.',
    )
    process.exit(1)
  }

  logger.info(
    { appId, installationId, appBotLogin },
    'GitHub App authentication verified — installation token minted successfully',
  )

  const getToken = async (): Promise<string> => {
    // createAppAuth handles token caching and auto-refresh internally
    const tokenAuth = await auth({ type: 'installation' })
    return tokenAuth.token
  }

  return { octokit, getToken, appBotLogin }
}
