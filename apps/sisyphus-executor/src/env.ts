import { createSafeEnv } from '@bluetel-ai/env-validation-errors'

import { serverSchemas } from './env-schemas'

/**
 * The validated environment for the executor — **instance-level values only**.
 *
 * Job parameters and the workflow-scoped credential arrive in the user-data
 * envelope and are never read from here; see the note at the top of
 * `env-schemas.ts` for why that boundary is load-bearing.
 *
 * `runtimeEnv` is written out variable by variable rather than spread from
 * `process.env`, so a missing bucket name fails at boot naming the variable
 * rather than surfacing as `undefined` mid-bootstrap — on an instance whose
 * only channel for reporting a failure is the machine surface, an early, named
 * failure is the difference between a diagnosable bootstrap error and a
 * workflow that stalls until the reconciler reaps it.
 */
export const env = createSafeEnv({
  server: serverSchemas,
  runtimeEnv: {
    AWS_REGION: process.env.AWS_REGION,
    SISYPHUS_STAGE: process.env.SISYPHUS_STAGE,
    SISYPHUS_MACHINE_SURFACE_URL: process.env.SISYPHUS_MACHINE_SURFACE_URL,
    SISYPHUS_LOGS_BUCKET: process.env.SISYPHUS_LOGS_BUCKET,
    SISYPHUS_SNAPSHOTS_BUCKET: process.env.SISYPHUS_SNAPSHOTS_BUCKET,
    SISYPHUS_BUNDLES_BUCKET: process.env.SISYPHUS_BUNDLES_BUCKET,
    SISYPHUS_ARTIFACTS_BUCKET: process.env.SISYPHUS_ARTIFACTS_BUCKET,
    SISYPHUS_WORKSPACE_ROOT: process.env.SISYPHUS_WORKSPACE_ROOT,
  },
})
