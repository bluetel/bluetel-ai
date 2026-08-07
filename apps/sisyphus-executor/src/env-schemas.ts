/**
 * Environment schema for the executor.
 *
 * ---------------------------------------------------------------------------
 * INSTANCE-LEVEL VALUES ONLY — this is a requirement, not a style preference
 * ---------------------------------------------------------------------------
 * Configuration reaches the executor through the **user-data job envelope**,
 * not through the environment. This schema covers only what the instance itself
 * needs regardless of which job it happens to be running: the region, the
 * machine surface URL, the bucket names and the pinned workspace root.
 *
 * Every job parameter — workflow id, session id, model, turn cap, spend cap,
 * workflow type, setup bundle key and digest, workspace entries, the assembled
 * prompt, the resume snapshot — and, above all, the **workflow-scoped
 * credential** arrive in that envelope (`job-envelope.ts`), so that nothing
 * job-specific is ever readable from `process.env`.
 *
 * That matters because the instance runs a setup bundle and an agent, both of
 * which execute arbitrary code with full access to the process environment. A
 * credential placed here would be readable by anything the agent runs; in the
 * envelope it is parsed once, held in memory, and scoped to one workflow
 * (FR-037). **Do not add job configuration to this schema.**
 *
 * Server-only: there is no browser bundle here, so there is no client schema.
 */

import { z } from 'zod'

export const serverSchemas = {
  AWS_REGION: z.string().min(1).default('eu-west-2'),
  /** Plain stage name, for log correlation. */
  SISYPHUS_STAGE: z.string().min(1),

  /**
   * Default base URL of the machine surface. The job envelope carries its own
   * `machineSurfaceUrl` and takes precedence; this is the instance-level
   * fallback so a boot that fails before the envelope is parsed can still
   * report the failure.
   */
  SISYPHUS_MACHINE_SURFACE_URL: z.string().url(),

  /** Object storage the instance reads from and writes to. */
  SISYPHUS_LOGS_BUCKET: z.string().min(1),
  SISYPHUS_SNAPSHOTS_BUCKET: z.string().min(1),
  SISYPHUS_BUNDLES_BUCKET: z.string().min(1),
  SISYPHUS_ARTIFACTS_BUCKET: z.string().min(1),

  /**
   * The pinned workspace root. Fixed at `/workspace` because the agent derives
   * its session directory from the absolute working directory — an unpinned
   * path makes a restored session unfindable (FR-051). Configurable only so a
   * local integration test can run outside a container; a deployed instance
   * must not override it.
   */
  SISYPHUS_WORKSPACE_ROOT: z.string().min(1).default('/workspace'),
}

/** The executor has no client surface. Declared rather than omitted. */
export const clientSchemas = {}

export const processEnvKeys = [
  ...Object.keys(serverSchemas).map((key) => ({ key, secret: true })),
  ...Object.keys(clientSchemas).map((key) => ({ key, secret: false })),
]

/**
 * Names that must never appear in this schema, because they are job
 * configuration or credentials and belong in the user-data envelope. Asserted
 * in the colocated test so the rule is enforced rather than remembered.
 */
export const ENVELOPE_ONLY_KEYS: readonly string[] = [
  'SISYPHUS_WORKFLOW_ID',
  'SISYPHUS_SESSION_ID',
  'SISYPHUS_SCOPED_CREDENTIAL',
  'SISYPHUS_MODEL',
  'SISYPHUS_TURN_CAP',
  'SISYPHUS_SPEND_CAP',
  'SISYPHUS_WORKFLOW_TYPE',
  'SISYPHUS_PROMPT',
  'SISYPHUS_SETUP_BUNDLE_KEY',
  'SISYPHUS_SETUP_BUNDLE_DIGEST',
  'SISYPHUS_REPOSITORY_URL',
  'SISYPHUS_BASE_BRANCH',
  'SISYPHUS_RESUME_SNAPSHOT_KEY',
  'SISYPHUS_MODE',
]
