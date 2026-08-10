/**
 * Environment schema for the control plane.
 *
 * Server-only: the control plane has no browser bundle and no inbound network
 * surface (FR-035), so there is no client schema and no `NEXT_PUBLIC_` prefix
 * here. `clientSchemas` is exported as an empty dictionary anyway, so the split
 * between the two is stated rather than implied, and so `processEnvKeys` has
 * the same shape it has in the panel.
 *
 * Separate from `env.ts` so `sst.config.ts` can read `processEnvKeys` at deploy
 * time without triggering validation of runtime-only values.
 */

import { z } from 'zod'

const commaSeparatedList = () =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string()).min(1))

export const serverSchemas = {
  /** PostgreSQL connection URL. The control plane calls the tRPC router in-process. */
  DATABASE_URL: z.string().url(),

  /**
   * Addresses promoted to admin by the idempotent bootstrap reconcile that runs
   * after migration on every deploy (FR-174).
   *
   * This is the variable that breaks the first-admin deadlock: users are
   * auto-created as `engineer` and every route to `admin` requires an existing
   * admin, so without a seed nobody can configure anything at all. It is
   * therefore **required and non-empty** — recovering from the
   * every-admin-deactivated state is meant to be a redeploy, not a manual
   * database edit, and that only works if the value is always present.
   *
   * Format: a comma-separated list of email addresses, lower-cased and trimmed.
   * Removing an address does not demote anyone; revocation stays an explicit,
   * attributed action.
   */
  SISYPHUS_BOOTSTRAP_ADMIN_EMAILS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string().email()).min(1)),

  /** Base URL of the machine surface, handed to each executor in its envelope. */
  SISYPHUS_MACHINE_SURFACE_URL: z.string().url(),
  /** Key workflow-scoped executor credentials are minted with (FR-037). */
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: z.string().min(1),

  /** All four object classes: the control plane provisions them and verifies durability at teardown. */
  SISYPHUS_LOGS_BUCKET: z.string().min(1),
  SISYPHUS_SNAPSHOTS_BUCKET: z.string().min(1),
  SISYPHUS_BUNDLES_BUCKET: z.string().min(1),
  SISYPHUS_ARTIFACTS_BUCKET: z.string().min(1),

  /** EventBridge Scheduler wiring for per-integration schedules (FR-100). */
  SISYPHUS_SCHEDULE_GROUP_NAME: z.string().min(1),
  SISYPHUS_SCHEDULER_TARGET_ARN: z.string().min(1),
  SISYPHUS_SCHEDULER_ROLE_ARN: z.string().min(1),

  /** What an executor instance is launched with (FR-036). */
  SISYPHUS_EXECUTOR_AMI_ID: z.string().min(1),
  SISYPHUS_EXECUTOR_INSTANCE_PROFILE_ARN: z.string().min(1),
  SISYPHUS_EXECUTOR_SUBNET_IDS: commaSeparatedList(),
  SISYPHUS_EXECUTOR_SECURITY_GROUP_IDS: commaSeparatedList(),

  /** Slack bot token for owner direct messages — the only notification channel in scope (FR-136). */
  SISYPHUS_SLACK_BOT_TOKEN: z.string().min(1),

  /**
   * Where the panel is served, so a notification can link to the run it is about (FR-137).
   *
   * The control plane composes the message but never serves it, so it cannot derive this from a
   * request — a notification that names a run without linking to it makes the reader search for it.
   */
  SISYPHUS_PANEL_URL: z.string().url(),

  /**
   * The most compute leases that may be live at once (FR-040).
   *
   * Read at admission, counted against `compute_leases` rather than workflow rows, because a lease
   * is what costs money. Configuration rather than a constant so a stage can be given a smaller
   * ceiling than production without a deploy of different code.
   */
  SISYPHUS_CONCURRENCY_CEILING: z.coerce.number().int().positive().default(5),

  /**
   * How long an agent credential may sit unused before keep-alive exercises it (FR-035).
   *
   * The default is the conservative 24h of research R2, not a measured figure: the real
   * idle-expiry window of a subscription login is unknown until T125 measures it. That is
   * precisely why this is configuration — tuning it from evidence must not need a deploy of
   * different code.
   */
  SISYPHUS_KEEPALIVE_IDLE_HOURS: z.coerce.number().positive().default(24),

  /**
   * How long a workflow may sit in `awaiting_credential` before it fails naming credential
   * exhaustion (FR-028).
   *
   * A queue with no limit is indistinguishable from a stuck run, so the wait is bounded and the
   * failure names its cause rather than timing out somewhere further down.
   */
  SISYPHUS_CREDENTIAL_WAIT_LIMIT_MINUTES: z.coerce.number().positive().default(60),

  /**
   * How long a lease may be held before an administrator is alerted, naming the holding
   * workflow (FR-056).
   *
   * An expectation rather than a ceiling: nothing is force-released on it. A parked run
   * legitimately holds a seat for a long time, so this raises attention rather than acting.
   */
  SISYPHUS_LEASE_HOLD_EXPECTATION_HOURS: z.coerce.number().positive().default(12),

  /**
   * How often a credential in `cooling_off` with no `cooling_off_until` is retried (FR-078).
   *
   * A provider that rate-limits without stating a reset time leaves nothing to wait on, so the
   * retry cadence is ours to choose — and unmeasured (research R1), hence configuration.
   */
  SISYPHUS_COOLING_OFF_RETRY_MINUTES: z.coerce.number().positive().default(15),

  /**
   * Secrets Manager name prefix under which one secret per agent credential is created
   * (research R8).
   *
   * One secret per credential, named from this prefix, is what keeps rotation a
   * `PutSecretValue` against a stable identifier rather than a rename — and what keeps the
   * IAM policy the executor's instance profile carries scoped to a prefix rather than to `*`.
   */
  SISYPHUS_AGENT_CREDENTIAL_SECRET_PREFIX: z.string().min(1),

  AWS_REGION: z.string().min(1).default('eu-west-2'),
  SISYPHUS_STAGE: z.string().min(1),
}

/** The control plane has no client surface. Declared rather than omitted. */
export const clientSchemas = {}

export const processEnvKeys = [
  ...Object.keys(serverSchemas).map((key) => ({ key, secret: true })),
  ...Object.keys(clientSchemas).map((key) => ({ key, secret: false })),
]
