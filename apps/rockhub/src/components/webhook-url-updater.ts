/**
 * Webhook_URL_Updater — Updates the GitHub App's webhook delivery URL on startup.
 *
 * On every Rockhub startup, after the Tunnel_Manager produces a Tunnel_URL,
 * this component calls `PATCH /app/hook/config` to point the GitHub App's
 * webhook URL at the current tunnel. Authenticates with an App-level JWT
 * (NOT an Installation_Token) because the endpoint is App-scoped (Req 17.2).
 *
 * Failure is non-fatal (Req 17.5): the function logs at `warn` level but
 * never throws, allowing the process to continue starting up.
 */

import { createAppAuth } from '@octokit/auth-app'
import type pino from 'pino'

// ── Public Interface ────────────────────────────────────────────────

export interface WebhookUrlUpdaterConfig {
  appId: string
  privateKey: string // raw PEM
}

export interface WebhookUrlUpdaterDeps {
  logger: pino.Logger
}

export interface WebhookUrlUpdaterInstance {
  /**
   * Updates the GitHub App's webhook URL. Logs failures at warn level
   * but never throws — webhook URL update is non-fatal (Req 17.5).
   */
  updateWebhookUrl: (webhookUrl: string) => Promise<void>
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Creates a Webhook_URL_Updater that calls `PATCH /app/hook/config`
 * using an App-level JWT to set the GitHub App's webhook delivery URL.
 *
 * The returned `updateWebhookUrl` function NEVER throws — all errors
 * are caught and logged at `warn` level so the startup sequence is
 * not interrupted by a webhook URL update failure.
 */
export const createWebhookUrlUpdater = (
  config: WebhookUrlUpdaterConfig,
  deps: WebhookUrlUpdaterDeps,
): WebhookUrlUpdaterInstance => {
  const { appId, privateKey } = config
  const { logger } = deps
  const log = logger.child({ component: 'webhook-url-updater' })

  const updateWebhookUrl = async (webhookUrl: string): Promise<void> => {
    try {
      const appAuth = createAppAuth({ appId, privateKey })
      const { token: jwt } = await appAuth({ type: 'app' })

      const response = await fetch('https://api.github.com/app/hook/config', {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: webhookUrl }),
      })

      if (response.ok) {
        log.info({ webhookUrl }, 'GitHub App webhook URL updated')
      } else {
        const body = await response.text()
        log.warn(
          { status: response.status, body, webhookUrl },
          'Failed to update GitHub App webhook URL',
        )
      }
    } catch (err) {
      log.warn({ err, webhookUrl }, 'Exception while updating GitHub App webhook URL')
    }
  }

  return { updateWebhookUrl }
}
