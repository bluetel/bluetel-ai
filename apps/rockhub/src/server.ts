import express from 'express'
import type pino from 'pino'

import type { WebhookReceiverResult } from './components'
import type { RockhubConfig } from './config'

export interface ServerDeps {
  webhookReceiver: WebhookReceiverResult
  logger: pino.Logger
}

export const createServer = (_config: RockhubConfig, deps: ServerDeps): express.Application => {
  const app = express()
  // Mount the webhook middleware — this is the ONLY route
  app.use(deps.webhookReceiver.middleware)
  return app
}
