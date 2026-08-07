import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabaseClient } from '../client'

/**
 * The forward-only migration runner.
 *
 * Two things make this a module rather than a CLI flag:
 *
 * 1. **Forward-only is checked, not assumed.** Drizzle will happily apply whatever SQL is in the
 *    folder; nothing in it objects to a hand-written rollback. {@link assertForwardOnly} refuses to
 *    run when one is present, so the rule holds against the next person as well as against this
 *    one. A rollback against a schema that in-flight workflows are reading is not a recovery
 *    procedure, it is a second outage — the forward fix is the only fix.
 * 2. **It runs on its own** (FR-010). Migrating is a separate, idempotent command that can be
 *    pointed at any stage, not a side effect of a deploy that has already begun replacing running
 *    code.
 */

/** One entry in drizzle-kit's `meta/_journal.json`. */
export interface MigrationJournalEntry {
  readonly idx: number
  readonly version: string
  /** Milliseconds since the epoch; also the value recorded in the migrations table. */
  readonly when: number
  /** The SQL file's basename without its extension. */
  readonly tag: string
  readonly breakpoints: boolean
}

export interface MigrationJournal {
  readonly version: string
  readonly dialect: string
  readonly entries: readonly MigrationJournalEntry[]
}

export interface MigrationReport {
  /** Migrations applied by this invocation, oldest first. */
  readonly applied: readonly string[]
  /** Migrations that were already recorded before this invocation. */
  readonly alreadyApplied: readonly string[]
}

/** Where drizzle-kit writes, and where this runner reads. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('.', import.meta.url))

/** Drizzle's bookkeeping lives in its own schema so it cannot collide with a platform table. */
export const MIGRATIONS_SCHEMA = 'drizzle'
export const MIGRATIONS_TABLE = '__drizzle_migrations'

const JOURNAL_RELATIVE_PATH = path.join('meta', '_journal.json')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseEntry = (value: unknown, index: number): MigrationJournalEntry => {
  if (!isRecord(value)) throw new Error(`Migration journal entry ${String(index)} is not an object`)
  const { idx, version, when, tag, breakpoints } = value
  if (typeof idx !== 'number' || typeof when !== 'number') {
    throw new Error(`Migration journal entry ${String(index)} is missing a numeric idx or when`)
  }
  if (typeof version !== 'string' || typeof tag !== 'string') {
    throw new Error(`Migration journal entry ${String(index)} is missing a string version or tag`)
  }
  return { idx, version, when, tag, breakpoints: breakpoints === true }
}

/** Parse a journal from its raw JSON, rejecting anything that is not the shape we rely on. */
export const parseMigrationJournal = (raw: string): MigrationJournal => {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error('Migration journal is not an object')
  }
  const { version, dialect, entries } = parsed
  if (typeof version !== 'string' || typeof dialect !== 'string') {
    throw new Error('Migration journal is missing its version or dialect')
  }
  if (!Array.isArray(entries)) throw new Error('Migration journal is missing its entries array')
  return { version, dialect, entries: entries.map(parseEntry) }
}

/**
 * Read the journal. A missing journal is an empty one: a fresh checkout that has never generated a
 * migration is not an error, it just has nothing to apply.
 */
export const readMigrationJournal = async (
  folder: string = MIGRATIONS_FOLDER,
): Promise<MigrationJournal> => {
  try {
    return parseMigrationJournal(await readFile(path.join(folder, JOURNAL_RELATIVE_PATH), 'utf8'))
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      return { version: '7', dialect: 'postgresql', entries: [] }
    }
    throw error
  }
}

/** Anything that looks like a rollback. Matched on the whole filename, case-insensitively. */
const ROLLBACK_PATTERN = /(^|[^a-z])(down|rollback|revert|undo)([^a-z]|$)/i

/**
 * Refuse to run against a folder that contains a rollback, or a journal that disagrees with the
 * files on disk.
 *
 * The ordering checks matter as much as the rollback check: drizzle applies migrations in journal
 * order and records `when`, so a duplicated or out-of-order timestamp silently skips a migration
 * on one stage and applies it on another.
 */
export const assertForwardOnly = (
  journal: MigrationJournal,
  fileNames: readonly string[],
): void => {
  const sqlFiles = fileNames.filter((name) => name.endsWith('.sql'))

  const rollbacks = sqlFiles.filter((name) => ROLLBACK_PATTERN.test(name))
  if (rollbacks.length > 0) {
    throw new Error(
      `Migrations are forward-only (FR-010); found what looks like a rollback: ${rollbacks.join(', ')}. Write a new forward migration instead.`,
    )
  }

  const tags = journal.entries.map((entry) => entry.tag)
  if (new Set(tags).size !== tags.length) {
    throw new Error('Migration journal contains a duplicate tag')
  }

  const timestamps = journal.entries.map((entry) => entry.when)
  for (let index = 1; index < timestamps.length; index += 1) {
    if ((timestamps[index] ?? 0) <= (timestamps[index - 1] ?? 0)) {
      throw new Error(
        `Migration journal is not strictly increasing at index ${String(index)}; migrations would apply in a different order on a database that has seen only some of them`,
      )
    }
  }

  journal.entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      throw new Error(
        `Migration journal entry ${entry.tag} has idx ${String(entry.idx)}, expected ${String(index)}`,
      )
    }
    if (!sqlFiles.includes(`${entry.tag}.sql`)) {
      throw new Error(`Migration journal names ${entry.tag}, but ${entry.tag}.sql is not on disk`)
    }
  })

  const journalled = new Set(tags.map((tag) => `${tag}.sql`))
  const orphans = sqlFiles.filter((name) => !journalled.has(name))
  if (orphans.length > 0) {
    throw new Error(
      `SQL files present but absent from the journal, so they would never be applied: ${orphans.join(', ')}`,
    )
  }
}

/** Split the journal into what a database has already seen and what it has not. */
export const summariseMigrations = (
  journal: MigrationJournal,
  appliedTimestamps: readonly number[],
): MigrationReport => {
  const applied = new Set(appliedTimestamps)
  return {
    applied: journal.entries.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag),
    alreadyApplied: journal.entries
      .filter((entry) => applied.has(entry.when))
      .map((entry) => entry.tag),
  }
}

export interface RunMigrationsOptions {
  readonly connectionString: string
  readonly migrationsFolder?: string
}

const readAppliedTimestamps = async (
  query: (sql: string) => Promise<readonly Record<string, unknown>[]>,
): Promise<number[]> => {
  const rows = await query(
    `select created_at from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" order by created_at`,
  )
  return rows.map((row) => Number(row['created_at']))
}

/**
 * Apply every outstanding migration, in order, on a single connection.
 *
 * Single connection is not a detail: `create type` and `alter table` taking locks across a pool
 * would let two of them deadlock against each other. The pool is opened and closed by this
 * function, so the command owns its connection and leaves nothing behind.
 */
export const runMigrations = async (options: RunMigrationsOptions): Promise<MigrationReport> => {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER
  const journal = await readMigrationJournal(migrationsFolder)
  assertForwardOnly(journal, await readdir(migrationsFolder))

  const client = createDatabaseClient({
    connectionString: options.connectionString,
    maxConnections: 1,
    // A long `create index` on a large table must not be cut off by the pool.
    maxLifetimeSeconds: 60 * 60,
  })

  try {
    const before = await readAppliedTimestamps(async (statement) => {
      try {
        return (await client.sql.unsafe(statement)) as unknown as Record<string, unknown>[]
      } catch {
        // No bookkeeping table yet: this database has never been migrated.
        return []
      }
    })

    await migrate(client.db, {
      migrationsFolder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    })

    return summariseMigrations(journal, before)
  } finally {
    await client.close()
  }
}
