import { createSafeEnv } from '@bluetel-ai/env-validation-errors'

import { serverSchemas } from './env-schemas'

/**
 * The validated environment for the control plane.
 *
 * Server-only: no `clientPrefix`, no client schema. Every value here is either a
 * credential or a resource identifier the job runner needs, and none of it has
 * anywhere to leak to, because the control plane has no browser bundle and no
 * inbound network surface (FR-035).
 *
 * `runtimeEnv` is written out variable by variable rather than spread from
 * `process.env`, so a bucket name or scheduler ARN that deploy-time
 * configuration forgot fails at boot naming the variable, instead of surfacing
 * as `undefined` halfway through provisioning an instance.
 */
export const env = createSafeEnv({
  server: serverSchemas,
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: process.env.SISYPHUS_BOOTSTRAP_ADMIN_EMAILS,
    SISYPHUS_MACHINE_SURFACE_URL: process.env.SISYPHUS_MACHINE_SURFACE_URL,
    SISYPHUS_MACHINE_CREDENTIAL_SECRET: process.env.SISYPHUS_MACHINE_CREDENTIAL_SECRET,
    SISYPHUS_LOGS_BUCKET: process.env.SISYPHUS_LOGS_BUCKET,
    SISYPHUS_SNAPSHOTS_BUCKET: process.env.SISYPHUS_SNAPSHOTS_BUCKET,
    SISYPHUS_BUNDLES_BUCKET: process.env.SISYPHUS_BUNDLES_BUCKET,
    SISYPHUS_ARTIFACTS_BUCKET: process.env.SISYPHUS_ARTIFACTS_BUCKET,
    SISYPHUS_SCHEDULE_GROUP_NAME: process.env.SISYPHUS_SCHEDULE_GROUP_NAME,
    SISYPHUS_SCHEDULER_TARGET_ARN: process.env.SISYPHUS_SCHEDULER_TARGET_ARN,
    SISYPHUS_SCHEDULER_ROLE_ARN: process.env.SISYPHUS_SCHEDULER_ROLE_ARN,
    SISYPHUS_EXECUTOR_AMI_ID: process.env.SISYPHUS_EXECUTOR_AMI_ID,
    SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN: process.env.SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN,
    SISYPHUS_EXECUTOR_SUBNET_IDS: process.env.SISYPHUS_EXECUTOR_SUBNET_IDS,
    SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS: process.env.SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS,
    SISYPHUS_SLACK_BOT_TOKEN: process.env.SISYPHUS_SLACK_BOT_TOKEN,
    SISYPHUS_PANEL_URL: process.env.SISYPHUS_PANEL_URL,
    SISYPHUS_CONCURRENCY_CEILING: process.env.SISYPHUS_CONCURRENCY_CEILING,
    SISYPHUS_KEEPALIVE_IDLE_HOURS: process.env.SISYPHUS_KEEPALIVE_IDLE_HOURS,
    SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES: process.env.SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES,
    SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS: process.env.SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS,
    SISYPHUS_COOLING_OFF_RETRY_MINUTES: process.env.SISYPHUS_COOLING_OFF_RETRY_MINUTES,
    SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX: process.env.SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX,
    AWS_REGION: process.env.AWS_REGION,
    SISYPHUS_STAGE: process.env.SISYPHUS_STAGE,
  },
})
