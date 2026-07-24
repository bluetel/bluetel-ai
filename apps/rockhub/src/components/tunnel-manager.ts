/**
 * Tunnel_Manager — Cloudflare Quick Tunnel manager (always-on, prod + dev).
 *
 * Creates and manages a Cloudflare Quick Tunnel using the `cloudflared`
 * npm package to expose the local Webhook_Receiver endpoint at a public
 * HTTPS URL. Unlike `kiro-github-worker`'s tunnel manager (which is
 * dev-only), this manager runs in every environment so the GitHub App
 * webhook URL can always point at the currently-running Rockhub.
 *
 * Behavior (Req 16):
 *   - Tunnel is created on every startup regardless of `NODE_ENV`.
 *   - If the `cloudflared` binary is missing, install it before opening.
 *   - If 30s elapse without a URL, log error and `process.exit(1)`.
 *   - If the tunnel emits `'error'` BEFORE the URL is produced, reject.
 *   - After the URL is produced, attach a long-lived `'error'` listener
 *     that logs at `warn` and continues (does NOT exit).
 *   - URL is printed in a boxed format and logged at `info` with `{ url, port }`.
 *   - `stop()` is idempotent and removes its own SIGINT/SIGTERM listeners
 *     so that graceful shutdown coordinated by main.ts does not double-fire.
 *
 * @see https://github.com/JacobLinCool/node-cloudflared
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
 */

import fs from 'node:fs'

import type pino from 'pino'

// ── Types ───────────────────────────────────────────────────────────

/**
 * Subset of the `cloudflared` package API used by the tunnel manager.
 * Defined here to avoid unsafe-any issues with the CJS dynamic import.
 */
interface CloudflaredModule {
  bin: string
  install: (to: string, version?: string) => Promise<string>
  Tunnel: {
    quick: (url?: string) => CloudflaredTunnel
  }
}

interface CloudflaredTunnel {
  stop: () => boolean
  once(event: 'url', listener: (url: string) => void): CloudflaredTunnel
  once(event: 'error', listener: (err: Error) => void): CloudflaredTunnel
  on(event: 'error', listener: (err: Error) => void): CloudflaredTunnel
}

export interface TunnelManagerConfig {
  port: number
}

export interface TunnelManagerInstance {
  /**
   * Opens the Cloudflare Quick Tunnel and resolves with the public
   * Tunnel_URL once the tunnel emits `'url'`.
   *
   * Behavior on failure:
   *   - 30s elapse without a URL → log `error`, call `process.exit(1)`.
   *   - Tunnel emits `'error'` before the URL is produced → rejects.
   */
  start(): Promise<string>
  /**
   * Stops the tunnel and removes the SIGINT/SIGTERM listeners that this
   * manager registered. Idempotent: safe to call multiple times; the
   * second call is a no-op.
   */
  stop(): void
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Dynamically imports the `cloudflared` CJS package and returns a
 * typed subset of its API.
 */
const loadCloudflared = async (): Promise<CloudflaredModule> => {
  const mod: unknown = await import('cloudflared')
  return mod as CloudflaredModule
}

/**
 * Creates a tunnel manager that exposes a local port via Cloudflare
 * Quick Tunnels. Always active (no NODE_ENV gate) — Rockhub treats the
 * tunnel as a hard dependency for receiving webhooks.
 *
 * @param config - Port configuration
 * @param logger - A pino logger instance
 * @returns An object with `start` and `stop` methods
 */
export const createTunnelManager = (
  config: TunnelManagerConfig,
  logger: pino.Logger,
): TunnelManagerInstance => {
  const log = logger.child({ component: 'tunnel-manager' })

  let tunnel: CloudflaredTunnel | null = null

  // ── Signal handlers ─────────────────────────────────────────────

  const onSignal = (): void => {
    stop()
  }

  // ── Public API ──────────────────────────────────────────────────

  const start = async (): Promise<string> => {
    const cloudflared = await loadCloudflared()

    // Ensure the cloudflared binary is installed (Req 16.2)
    if (!fs.existsSync(cloudflared.bin)) {
      log.info('cloudflared binary not found, installing…')
      await cloudflared.install(cloudflared.bin)
      log.info('cloudflared binary installed')
    }

    const localUrl = `http://localhost:${String(config.port)}`
    const activeTunnel = cloudflared.Tunnel.quick(localUrl)
    tunnel = activeTunnel

    // Wait for the tunnel URL to be assigned (Req 16.3, 16.4)
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        log.error(
          { port: config.port, timeoutMs: 30_000 },
          'Cloudflare tunnel did not produce a URL within 30s — exiting',
        )
        process.exit(1)
      }, 30_000)

      activeTunnel.once('url', (tunnelUrl: string) => {
        clearTimeout(timeout)
        resolve(tunnelUrl)
      })

      activeTunnel.once('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    // After the URL is produced, attach a long-lived `'error'` listener
    // that logs at warn level and continues (Req 16.5).
    activeTunnel.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'Cloudflare tunnel error (post-establishment)')
    })

    // Register process-level signal handlers (Req 16.6, 16.7).
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    log.info({ url, port: config.port }, 'Cloudflare tunnel established')

    // Print the URL to stdout in a boxed format (Req 16.3).
    const divider = '='.repeat(60)
    console.log(`\n${divider}`)
    console.log(`🔗 Tunnel URL: ${url}`)
    console.log(`${divider}\n`)

    return url
  }

  const stop = (): void => {
    // Remove our own signal listeners so a graceful shutdown coordinated
    // by main.ts does not double-fire (Req 16.7).
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)

    // Idempotent: only call the underlying tunnel.stop() once.
    if (tunnel) {
      log.info('Closing cloudflared tunnel')
      const activeTunnel = tunnel
      tunnel = null
      activeTunnel.stop()
    }
  }

  return { start, stop }
}
