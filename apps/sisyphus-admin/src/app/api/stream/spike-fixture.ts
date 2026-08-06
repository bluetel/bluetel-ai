/**
 * The minimum real-schema rows a `log_segments` insert needs.
 *
 * The spike measures the transport against the **actual** table — including its
 * `(workflow_id, sequence)` unique index and its foreign key to `workflows` — rather than a
 * throwaway table, because the index is what makes `appendLogSegment` idempotent and the FK is what
 * makes the insert cost realistic. That obliges us to seed the chain above it:
 * `users → setup_bundles → setup_bundle_versions` and `workspaces → workspace_versions`.
 *
 * Every row is tagged so {@link teardownSpikeFixture} can remove exactly what the spike created and
 * nothing else.
 */

import { randomUUID } from 'node:crypto'

import type { Sql } from 'postgres'

/** Prefix on every text column the spike writes, so a stray row is identifiable later. */
export const SPIKE_TAG_PREFIX = 'spike-s3'

export interface SpikeFixtureIdentifiers {
  readonly tag: string
  readonly userId: string
  readonly setupBundleId: string
  readonly setupBundleVersionId: string
  readonly workspaceId: string
  readonly workspaceVersionId: string
}

export const buildFixtureIdentifiers = (): SpikeFixtureIdentifiers => ({
  tag: `${SPIKE_TAG_PREFIX}-${randomUUID().slice(0, 8)}`,
  userId: randomUUID(),
  setupBundleId: randomUUID(),
  setupBundleVersionId: randomUUID(),
  workspaceId: randomUUID(),
  workspaceVersionId: randomUUID(),
})

export const seedSpikeFixture = async (
  sql: Sql,
  identifiers: SpikeFixtureIdentifiers,
): Promise<void> => {
  const { tag, userId, setupBundleId, setupBundleVersionId, workspaceId, workspaceVersionId } =
    identifiers

  await sql`
    insert into users (id, email, google_subject, display_name, role)
    values (${userId}, ${`${tag}@example.invalid`}, ${`${tag}-subject`}, ${tag}, 'engineer')
  `
  await sql`
    insert into setup_bundles (id, name, enabled, spend_caps_enforceable, created_by_user_id)
    values (${setupBundleId}, ${`${tag}-bundle`}, true, false, ${userId})
  `
  await sql`
    insert into setup_bundle_versions
      (id, setup_bundle_id, version, s3_key, content_digest, size_bytes, registered_by_user_id)
    values (${setupBundleVersionId}, ${setupBundleId}, 1, ${`${tag}/bundle.tar.gz`}, ${tag}, 1, ${userId})
  `
  await sql`
    insert into workspaces (id, name, enabled)
    values (${workspaceId}, ${`${tag}-workspace`}, true)
  `
  await sql`
    insert into workspace_versions (id, workspace_id, version, created_by_user_id)
    values (${workspaceVersionId}, ${workspaceId}, 1, ${userId})
  `
}

/** One workflow per scenario, so each transport gets a clean `(workflow_id, sequence)` range. */
export const createSpikeWorkflow = async (
  sql: Sql,
  identifiers: SpikeFixtureIdentifiers,
): Promise<string> => {
  const workflowId = randomUUID()
  await sql`
    insert into workflows
      (id, type, state, owner_user_id, setup_bundle_version_id, workspace_version_id,
       model, instance_type, purchase_mode, session_id)
    values (${workflowId}, 'delegated', 'running', ${identifiers.userId},
            ${identifiers.setupBundleVersionId}, ${identifiers.workspaceVersionId},
            'claude-sonnet-5', 'spike-instance', 'spot', ${randomUUID()})
  `
  return workflowId
}

/** Reverse dependency order; safe to call twice. */
export const teardownSpikeFixture = async (
  sql: Sql,
  identifiers: SpikeFixtureIdentifiers,
): Promise<void> => {
  const { userId, setupBundleId, setupBundleVersionId, workspaceId, workspaceVersionId } =
    identifiers
  await sql`delete from log_segments where workflow_id in (select id from workflows where owner_user_id = ${userId})`
  await sql`delete from workflows where owner_user_id = ${userId}`
  await sql`delete from workspace_versions where id = ${workspaceVersionId}`
  await sql`delete from workspaces where id = ${workspaceId}`
  await sql`delete from setup_bundle_versions where id = ${setupBundleVersionId}`
  await sql`delete from setup_bundles where id = ${setupBundleId}`
  await sql`delete from users where id = ${userId}`
}
