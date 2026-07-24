/**
 * Rockhub entry point — wires all components and starts the process.
 *
 * Wiring order:
 *   1. loadEnvFiles()
 *   2. parseConfig()
 *   3. createLogger(config.logLevel)
 *   4. await createAuth(...)
 *  4a. createTunnelManager(...) + createWebhookUrlUpdater(...)
 *  4b. await tunnelManager.start()
 *  4c. await webhookUrlUpdater.updateWebhookUrl(...)
 *   5. createRepoFilter(...)
 *   6. createEventFilter(...)
 *   7. createEyesReactor(...)
 *   8. createOpenclawSpawner(...)
 *   9. createPipeline(...)
 *  10. createMentionQueue({ logger, process: pipeline })
 *  11. createStartupScanner(...)
 *  12. createWebhookReceiver(...)
 *  13. createServer(...)
 *  14. Run startupScanner.scan() (parallel with app.listen)
 *  15. Start HTTP server on config.port
 *  16. Register SIGINT/SIGTERM handlers
 *
 * Requirements: 5.7, 8.4, 10.4, 10.5, 11.2, 11.5, 12.1, 12.2, 16.1, 16.6, 17.1, 17.6, 17.7
 */

import {
  createAuth,
  createEventFilter,
  createEyesReactor,
  createMentionQueue,
  createOpenclawAgentRegistry,
  createOpenclawSpawner,
  createPipeline,
  createRepoFilter,
  createStartupScanner,
  createTunnelManager,
  createWebhookReceiver,
  createWebhookUrlUpdater,
} from './components'
import { loadEnvFiles, parseConfig } from './config'
import { createLogger } from './lib'
import { createServer } from './server'

const main = async (): Promise<void> => {
  // 1. Load .env.local from app root and workspace root (workspace root precedence)
  loadEnvFiles()

  // 2. Parse and validate config (exits 1 on failure)
  const config = parseConfig()

  // 3. Create logger
  const logger = createLogger(config.logLevel)
  logger.info('Rockhub starting')

  // 4. Create auth — mint installation token (exits 1 on failure)
  const auth = await createAuth(
    {
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      installationId: config.githubAppInstallationId,
    },
    logger,
  )

  // 4a. Create tunnel manager and webhook URL updater
  const tunnelManager = createTunnelManager({ port: config.port }, logger)
  const webhookUrlUpdater = createWebhookUrlUpdater(
    { appId: config.githubAppId, privateKey: config.githubAppPrivateKey },
    { logger },
  )

  // 4b. Start tunnel — exits 1 on failure (handled inside the manager)
  const tunnelUrl = await tunnelManager.start()

  // 4c. Update GitHub App webhook URL to point at the tunnel
  const webhookUrl = `${tunnelUrl}${config.webhookPath}`
  await webhookUrlUpdater.updateWebhookUrl(webhookUrl)

  // 5. Create repo filter
  const repoFilter = createRepoFilter(
    { allowedRepos: config.allowedRepos, deniedRepos: config.deniedRepos },
    logger,
  )

  // 6. Create event filter
  const eventFilter = createEventFilter({ botUsername: config.botUsername }, logger)

  // 7. Create eyes reactor (depends on auth.octokit)
  const eyesReactor = createEyesReactor({ octokit: auth.octokit, logger })

  // 8. Create openclaw spawner (depends on config and logger)
  // 8a. Create the agent registry first so the spawner can record each
  //     dynamically-created agent for later cleanup.
  const openclawAgentRegistry = createOpenclawAgentRegistry(
    {
      logDir: config.openclawLogDir,
      cliPath: config.openclawCliPath,
    },
    { logger },
  )
  await openclawAgentRegistry.start()

  const openclawSpawner = createOpenclawSpawner(
    {
      cliPath: config.openclawCliPath,
      skillFlag: config.openclawSubCommand,
      payloadTransport: config.openclawPayloadTransport,
      logDir: config.openclawLogDir,
    },
    { logger, agentRegistry: openclawAgentRegistry },
  )

  // 9. Create pipeline (eyes → spawn)
  const pipeline = createPipeline({ eyesReactor, openclawSpawner, logger })

  // 10. Create mention queue with pipeline as the process callback
  const mentionQueue = createMentionQueue({ logger, process: pipeline })

  // 11. Create startup scanner
  const startupScanner = createStartupScanner({
    octokit: auth.octokit,
    appBotLogin: auth.appBotLogin,
    botUsername: config.botUsername,
    repoFilter,
    eventFilter,
    mentionQueue,
    logger,
  })

  // 12. Create webhook receiver
  const webhookReceiver = createWebhookReceiver(
    { webhookPath: config.webhookPath, webhookSecret: config.githubWebhookSecret },
    { eventFilter, repoFilter, mentionQueue, logger },
  )

  // 13. Create server
  const app = createServer(config, { webhookReceiver, logger })

  // Start the mention queue drain loop
  mentionQueue.start()

  // 14. Run startup scanner (after webhook URL update; parallel with app.listen is fine)
  startupScanner
    .scan()
    .then((scanResult) => {
      logger.info(
        { enqueued: scanResult.enqueued, scanned: scanResult.scanned },
        'Startup scan complete',
      )
    })
    .catch((err: unknown) => {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Startup scan failed',
      )
    })

  // 15. Start HTTP server
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, webhookPath: config.webhookPath },
      'Rockhub HTTP server listening',
    )
  })

  // 16. Register SIGINT/SIGTERM handlers for graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Graceful shutdown initiated')

    // Stop accepting new connections
    server.close()

    // Stop the agent cleanup interval
    openclawAgentRegistry.stop()

    // Take down the public tunnel URL
    tunnelManager.stop()

    // Drain the mention queue (drops remaining items, waits for in-flight)
    await mentionQueue.drain()

    logger.info('Graceful shutdown complete')
    process.exit(0)
  }

  // Force-exit after 10 seconds if shutdown stalls
  const forceShutdown = (signal: string): void => {
    shutdown(signal).catch((err: unknown) => {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Error during shutdown',
      )
      process.exit(1)
    })

    setTimeout(() => {
      logger.warn('Shutdown stalled past 10 seconds — forcing exit')
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGINT', () => forceShutdown('SIGINT'))
  process.on('SIGTERM', () => forceShutdown('SIGTERM'))
}

// Run and handle unhandled exceptions in the top-level bootstrap
main().catch((err: unknown) => {
  console.error('[rockhub] Fatal error during startup:', err)
  process.exit(1)
})
