import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { Sql } from 'postgres'

import * as schema from './schema'

/**
 * The Drizzle client factory and its pooled connection.
 *
 * Nothing in this package opens a connection at import time. The pool is created when a caller
 * asks for one and the connection itself is opened lazily by the driver on first query, so
 * importing the schema — which the panel's build, the migration tooling and every test do — never
 * needs a reachable database.
 */

/** The typed database handle every query in the platform runs through. */
export type SisyphusDatabase = PostgresJsDatabase<typeof schema>

export interface DatabaseClientOptions {
  /** `postgres://user:password@host:port/database`. */
  readonly connectionString: string
  /**
   * Pool size. Lambda concurrency is per-container, so this is per *runtime instance*, not
   * platform-wide: a small number times many containers is still a lot of connections at the
   * database, and RDS `max_connections` is the ceiling that actually matters.
   */
  readonly maxConnections?: number
  /** Seconds an idle connection is kept before the pool drops it. */
  readonly idleTimeoutSeconds?: number
  /** Seconds to wait for a connection before giving up rather than hanging the request. */
  readonly connectTimeoutSeconds?: number
  /**
   * Seconds after which a connection is recycled even if healthy. Bounds the damage from a
   * failover that leaves connections pointing at a demoted instance.
   */
  readonly maxLifetimeSeconds?: number
  /**
   * Whether to use prepared statements. **Off by default**: a transaction-mode pooler hands the
   * next statement to a different backend, where a statement prepared on the previous one does not
   * exist. Turn it on only against a session-mode pool or a direct connection.
   */
  readonly prepare?: boolean
  /** Log SQL as it is issued. Never enable in production — statements carry redacted-only data. */
  readonly logger?: boolean
}

/** A pool plus the Drizzle handle bound to it, and the one way to shut both down. */
export interface DatabaseClient {
  readonly db: SisyphusDatabase
  /** The raw driver, for the migration runner and for `LISTEN`/advisory locks (FR-120). */
  readonly sql: Sql
  /** Close the pool. Idempotent. */
  readonly close: () => Promise<void>
}

const DEFAULT_MAX_CONNECTIONS = 10
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10
const DEFAULT_MAX_LIFETIME_SECONDS = 60 * 30

/**
 * Create a pooled Drizzle client.
 *
 * Every call creates a *new* pool. Request-scoped code should take the memoised
 * {@link getDatabaseClient} instead; this exists for the migration runner and for tests, which
 * both want a pool they own and can close.
 */
export const createDatabaseClient = (options: DatabaseClientOptions): DatabaseClient => {
  const connectionString = options.connectionString.trim()
  if (connectionString === '') {
    throw new Error(
      'createDatabaseClient needs a connection string. A blank one fails on first query instead of at startup, which turns a missing configuration value into an unrelated-looking runtime error.',
    )
  }

  const sql = postgres(connectionString, {
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    idle_timeout: options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    connect_timeout: options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
    max_lifetime: options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS,
    prepare: options.prepare ?? false,
    // RDS's default parameter group sets `rds.force_ssl=1`, rejecting any unencrypted connection.
    // `require` matches libpq's connection mode of the same name: encrypted, without verifying the
    // server certificate against a CA.
    ssl: 'require',
    onnotice: () => {
      // Postgres notices are not application events; swallow rather than writing them to the
      // workflow log, which is sanitised output meant for a human reading a run.
    },
  })

  const db = drizzle(sql, { schema, logger: options.logger ?? false })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await sql.end({ timeout: 5 })
  }

  return { db, sql, close }
}

let memoised: DatabaseClient | undefined

/**
 * The process-wide client.
 *
 * A Lambda container serves many invocations; creating a pool per invocation exhausts RDS
 * connections long before it exhausts anything else. Holding it on the module means the pool
 * survives between invocations on a warm container and dies with it.
 */
export const getDatabaseClient = (options: DatabaseClientOptions): DatabaseClient => {
  memoised ??= createDatabaseClient(options)
  return memoised
}

/**
 * Drop the memoised client, closing its pool.
 *
 * Used by tests and by the migration runner, which must not leave a pool open behind a one-shot
 * command.
 */
export const resetDatabaseClient = async (): Promise<void> => {
  const current = memoised
  memoised = undefined
  await current?.close()
}
