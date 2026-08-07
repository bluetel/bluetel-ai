import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import {
  bigIntColumn,
  createdAtColumn,
  disabledByDefaultColumn,
  idColumn,
  timestampColumn,
} from './columns'
import { artifactKindEnum, skillNameEnum, snapshotBoundaryEnum } from './enums'
import { workflowEntries, workflows } from './workflow'

/**
 * The record of what a run actually produced: its log, its snapshots, its artifacts and the skills
 * it resolved.
 *
 * Payloads live in S3; these tables hold keys, digests and sizes. They exist because a bucket
 * alone cannot answer "what did this workflow produce" without listing a prefix and guessing, and
 * FR-014 and SC-012 both require exactly that question to be answerable for the full retention
 * period.
 */

/**
 * A contiguous slice of the agent's output.
 *
 * Segments concatenate across resumptions into **one continuous ordered log**, reconciled by
 * `sequence` rather than by arrival time (FR-046, R6) — which is what the unique index enforces.
 * Content is sanitised and redacted *before* it is written, so an unsanitised copy never exists at
 * rest (FR-019, FR-045, FR-072).
 */
export const logSegments = pgTable(
  'log_segments',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    sequence: bigIntColumn('sequence').notNull(),
    s3Key: text('s3_key').notNull(),
    byteSize: bigIntColumn('byte_size').notNull(),
    startedAt: timestampColumn('started_at').notNull(),
    endedAt: timestampColumn('ended_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('log_segments_sequence_key').on(table.workflowId, table.sequence)],
)

/**
 * A restorable point in the run.
 *
 * A snapshot missing either state flag is **not resumable** (FR-050) — conversation state without
 * the worktree restores an agent whose filesystem beliefs are wrong, and the worktree without the
 * conversation restores a tree nobody can explain. The partial unique index gives each workflow at
 * most one current snapshot. `truncationRepaired` records a discarded trailing line as a normal
 * outcome rather than a corruption (FR-053), and `expiresAt` drives retention: a successor cannot
 * be created from an expired snapshot and is refused with the retention limit stated.
 */
export const sessionSnapshots = pgTable(
  'session_snapshots',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    /** The platform-assigned session id the agent was started with (FR-052, R2). */
    sessionId: uuid('session_id').notNull(),
    s3Key: text('s3_key').notNull(),
    sizeBytes: bigIntColumn('size_bytes').notNull(),
    boundary: snapshotBoundaryEnum('boundary').notNull(),
    hasConversationState: boolean('has_conversation_state').notNull(),
    hasWorktreeState: boolean('has_worktree_state').notNull(),
    truncationRepaired: disabledByDefaultColumn('truncation_repaired'),
    isCurrent: boolean('is_current').notNull().default(false),
    expiresAt: timestampColumn('expires_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('session_snapshots_current_key')
      .on(table.workflowId)
      .where(sql`${table.isCurrent}`),
    index('session_snapshots_workflow_idx').on(table.workflowId, table.createdAt.desc()),
  ],
)

/**
 * Everything the run produced that a human might want back.
 *
 * An artifact whose object has expired is still **listed**, with its expiry, rather than
 * vanishing — so a gap in the record reads as retention rather than as loss.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    /** Null for artifacts that belong to the run as a whole rather than one repository. */
    entryId: uuid('entry_id').references((): AnyPgColumn => workflowEntries.id),
    kind: artifactKindEnum('kind').notNull(),
    /** Exactly one of `s3Key` and `externalUrl` is set: a PR lives elsewhere, a diff lives in S3. */
    s3Key: text('s3_key'),
    externalUrl: text('external_url'),
    byteSize: bigIntColumn('byte_size'),
    createdAt: createdAtColumn(),
    expiresAt: timestampColumn('expires_at'),
  },
  (table) => [index('artifacts_workflow_kind_idx').on(table.workflowId, table.kind)],
)

/**
 * The skills a run actually resolved, and the version of each.
 *
 * The digest **is** the version: skills are repository files with no version number of their own,
 * so hashing the content is the only thing that distinguishes "this run followed today's
 * convention" from "this run followed the one before it" (FR-059, SC-016). Resolved from the
 * primary entry only (FR-110).
 *
 * A missing or unreadable skill is recorded here with a null `resolvedPath` and null
 * `contentDigest` **and** halts the workflow naming the skill (FR-058): the absence is as much a
 * fact about the run as the presence, and a row that simply did not exist would be indistinguishable
 * from a run that predates the skill.
 */
export const skillReferences = pgTable(
  'skill_references',
  {
    id: idColumn(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references((): AnyPgColumn => workflows.id),
    skillName: skillNameEnum('skill_name').notNull(),
    entryId: uuid('entry_id').references((): AnyPgColumn => workflowEntries.id),
    /** Null when the skill could not be resolved — the recorded absence (FR-058). */
    resolvedPath: text('resolved_path'),
    /** sha256 of the resolved content; null alongside a null `resolvedPath`. */
    contentDigest: text('content_digest'),
    /** Which part of the run resolved it. */
    phase: text('phase'),
    unavailableReason: text('unavailable_reason'),
    recordedAt: timestampColumn('recorded_at').notNull().defaultNow(),
  },
  (table) => [index('skill_references_workflow_idx').on(table.workflowId, table.skillName)],
)

export type LogSegment = typeof logSegments.$inferSelect
export type NewLogSegment = typeof logSegments.$inferInsert
export type SessionSnapshot = typeof sessionSnapshots.$inferSelect
export type NewSessionSnapshot = typeof sessionSnapshots.$inferInsert
export type Artifact = typeof artifacts.$inferSelect
export type NewArtifact = typeof artifacts.$inferInsert
export type SkillReference = typeof skillReferences.$inferSelect
export type NewSkillReference = typeof skillReferences.$inferInsert
