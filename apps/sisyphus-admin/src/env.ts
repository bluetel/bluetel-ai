import { createSafeEnv } from '@bluetel-ai/env-validation-errors'

import { clientSchemas, serverSchemas } from './env-schemas'

/**
 * The validated environment for the admin panel.
 *
 * `runtimeEnv` is written out variable by variable rather than spread from
 * `process.env`. Next.js only inlines `process.env.X` when `X` is written
 * literally, so the explicit map is what makes a missing variable fail at boot
 * naming the variable, instead of arriving as `undefined` somewhere in the
 * middle of bootstrap.
 *
 * `SKIP_ENV_VALIDATION=true` is honoured by `createSafeEnv`, which is how tests
 * and static analysis import modules that transitively reach this one.
 */
export const env = createSafeEnv({
  clientPrefix: 'NEXT_PUBLIC_',
  server: serverSchemas,
  client: clientSchemas,
  runtimeEnv: {
    // Server
    DATABASE_URL: process.env.DATABASE_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    AUTH_URL: process.env.AUTH_URL,
    SISYPHUS_PERMITTED_EMAIL_DOMAINS: process.env.SISYPHUS_PERMITTED_EMAIL_DOMAINS,
    SISYPHUS_MACHINE_CREDENTIAL_SECRET: process.env.SISYPHUS_MACHINE_CREDENTIAL_SECRET,
    SISYPHUS_WEBHOOK_SIGNING_SECRET: process.env.SISYPHUS_WEBHOOK_SIGNING_SECRET,
    SISYPHUS_SLACK_BOT_TOKEN: process.env.SISYPHUS_SLACK_BOT_TOKEN,
    SISYPHUS_PANEL_URL: process.env.SISYPHUS_PANEL_URL,
    SISYPHUS_LOGS_BUCKET: process.env.SISYPHUS_LOGS_BUCKET,
    SISYPHUS_BUNDLES_BUCKET: process.env.SISYPHUS_BUNDLES_BUCKET,
    SISYPHUS_ARTIFACTS_BUCKET: process.env.SISYPHUS_ARTIFACTS_BUCKET,
    AWS_REGION: process.env.AWS_REGION,
    SISYPHUS_STAGE: process.env.SISYPHUS_STAGE,

    // Client
    NEXT_PUBLIC_NODE_ENV: process.env.NEXT_PUBLIC_NODE_ENV ?? process.env.NODE_ENV,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  },
})
