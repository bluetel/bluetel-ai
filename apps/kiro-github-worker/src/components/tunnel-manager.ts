/**
 * Tunnel manager for local development.
 *
 * Creates and manages a Cloudflare Quick Tunnel to expose the local
 * webhook endpoint during development. Only activates when
 * `NODE_ENV !== "production"`.
 *
 * Uses the `cloudflared` npm package which provides a typed API for
 * creating tunnels and managing the cloudflared binary installation.
 * Cloudflare Quick Tunnels require no account and provide stable,
 * long-lived connections without the socket timeout issues that
 * affect localtunnel on Node.js v18+.
 *
 * Features:
 * - Stable connections via Cloudflare's edge network
 * - Auto-installs the cloudflared binary on first use
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Prominent stdout output of the public URL
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
  /** Opens the tunnel and returns the public URL. No-op in production. */
  start(): Promise<string | null>
  /** Closes the tunnel gracefully. */
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
 * Quick Tunnels.
 *
 * The tunnel only activates when `NODE_ENV !== "production"`. In
 * production the `start()` method returns `null` and `stop()` is a
 * no-op.
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

  let stopTunnel: (() => boolean) | null = null

  const isProduction = process.env['NODE_ENV'] === 'production'

  // ── Signal handlers ─────────────────────────────────────────────

  const onSignal = (): void => {
    stop()
  }

  // ── Public API ──────────────────────────────────────────────────

  const start = async (): Promise<string | null> => {
    if (isProduction) {
      log.debug('Tunnel manager inactive in production mode')
      return null
    }

    try {
      const cloudflared = await loadCloudflared()

      // Ensure the cloudflared binary is installed
      if (!fs.existsSync(cloudflared.bin)) {
        log.info('cloudflared binary not found, installing…')
        await cloudflared.install(cloudflared.bin)
        log.info('cloudflared binary installed')
      }

      const tunnel = cloudflared.Tunnel.quick(`http://localhost:${String(config.port)}`)

      // Wait for the tunnel URL to be assigned
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for cloudflared tunnel URL (30s)'))
        }, 30_000)

        tunnel.once('url', (tunnelUrl: string) => {
          clearTimeout(timeout)
          resolve(tunnelUrl)
        })

        tunnel.once('error', (err: Error) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      // Store the stop function for graceful shutdown
      stopTunnel = tunnel.stop

      // Log tunnel errors
      tunnel.on('error', (err: Error) => {
        log.warn({ err }, 'Tunnel error')
      })

      // Register graceful shutdown handlers
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)

      log.info({ url, port: config.port }, 'Cloudflare tunnel established')
      console.log(`\n${'='.repeat(60)}`)
      console.log(`🔗 Tunnel URL: ${url}`)
      console.log(`${'='.repeat(60)}\n`)

      return url
    } catch (err) {
      log.error({ err }, 'Failed to open cloudflared tunnel')
      throw err
    }
  }

  const stop = (): void => {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)

    if (stopTunnel) {
      log.info('Closing cloudflared tunnel')
      stopTunnel()
      stopTunnel = null
    }
  }

  return { start, stop }
}
