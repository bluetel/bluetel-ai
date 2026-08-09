/**
 * Server and client environment schemas for the admin panel, declared
 * separately and split by prefix.
 *
 * Separate from `env.ts` so `processEnvKeys` can be read by `sst.config.ts` at
 * deploy time without importing `env.ts` and thereby triggering validation of
 * variables that only exist on the deployed runtime.
 *
 * The split is not cosmetic: anything in `clientSchemas` is inlined into the
 * browser bundle, so a value that must not leave the server belongs in
 * `serverSchemas` and nowhere else.
 */

import { z } from 'zod'

/**
 * Comma-separated list, trimmed, with empty entries dropped. Used for the
 * multi-valued deploy-time settings that a single environment variable has to
 * carry.
 */
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
  /** PostgreSQL connection URL. `sisyphus-api` owns the schema behind it (FR-005). */
  DATABASE_URL: z.string().url(),

  /** Auth.js session/JWT signing key. */
  AUTH_SECRET: z.string().min(1),
  /** Google OAuth client, used for the FR-011 sign-in. */
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  /**
   * The panel's canonical origin, read by Auth.js itself (`@auth/core` reads
   * `process.env.AUTH_URL` directly, not through this validated `env` module) to pin its callback
   * URLs and to derive `trustHost`. Without it in a deployed environment, Auth.js falls back to the
   * request's `Host` header and refuses it — `UntrustedHost` — because nothing told it that host was
   * expected. Optional only in development, where `@auth/core` already trusts the host because
   * `NODE_ENV !== 'production'`; declared here anyway so a missing value fails loudly in every other
   * environment instead of surfacing as a sign-in error days later.
   */
  AUTH_URL: process.env.NODE_ENV === 'development' ? z.string().url().optional() : z.string().url(),
  /**
   * Google Workspace domains permitted to sign in. The `hd` claim is verified
   * server-side against this list (FR-011) — an email suffix check on the
   * client could be trivially faked.
   */
  SISYPHUS_PERMITTED_EMAIL_DOMAINS: commaSeparatedList(),

  /**
   * Shared key the machine surface verifies workflow-scoped executor
   * credentials with; the control plane mints against the same key (FR-037).
   */
  SISYPHUS_MACHINE_CREDENTIAL_SECRET: z.string().min(1),
  /** Signing secret for `POST /api/webhook`, verified before the body is parsed (FR-017). */
  SISYPHUS_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),

  /**
   * Slack bot token for owner direct messages — the only notification channel in
   * scope (FR-136).
   *
   * The panel needs it because the panel mounts the **machine surface**: four of
   * FR-136's events plus `review_iteration_failed` are set by `sisyphus-api` when
   * an executor reports in, and `SisyphusDependencies.notifier` is how they leave
   * the package. The control plane reads the same variable for the two events its
   * own sweep writes, so one Slack app serves both hosts.
   */
  SISYPHUS_SLACK_BOT_TOKEN: z.string().min(1),

  /**
   * Where the panel is served, so a notification can link to the run it is about
   * (FR-137).
   *
   * Deliberately a separate variable from `NEXT_PUBLIC_SITE_URL` rather than
   * derived from it: this one is the *link target written into a Slack message*,
   * it is read only on the server, and it must be the same string the control
   * plane composes its messages against — two hosts writing links to two
   * different origins for the same run is the failure this avoids.
   */
  SISYPHUS_PANEL_URL: z.string().url(),

  /**
   * Object storage the panel reads through presigned URLs. Snapshots are
   * deliberately absent: the panel never serves session state.
   */
  SISYPHUS_LOGS_BUCKET: z.string().min(1),
  SISYPHUS_BUNDLES_BUCKET: z.string().min(1),
  SISYPHUS_ARTIFACTS_BUCKET: z.string().min(1),

  AWS_REGION: z.string().min(1).default('eu-west-2'),
  /** Plain stage name, for log correlation and stage-aware behaviour. */
  SISYPHUS_STAGE: z.string().min(1),
}

export const clientSchemas = {
  /**
   * Read by the tRPC route handlers to gate `onError`. Gating on this rather
   * than on `process.env.NODE_ENV` matters on the machine surface: an
   * unconditional `onError` would write executor-reported content into platform
   * logs, bypassing the FR-045 sanitisation the executor applies on its side.
   */
  NEXT_PUBLIC_NODE_ENV: z.enum(['development', 'test', 'production']),
  /** Absolute origin of the panel; Auth.js callbacks and absolute links resolve against it. */
  NEXT_PUBLIC_SITE_URL: z.string().url(),
}

/**
 * Pulled into the SST website construct to inject environment variables at
 * deploy time. Server values are wrapped as secrets; client values are inlined
 * into the browser bundle and therefore must not be.
 */
export const processEnvKeys = [
  ...Object.keys(serverSchemas).map((key) => ({ key, secret: true })),
  ...Object.keys(clientSchemas).map((key) => ({ key, secret: false })),
]
