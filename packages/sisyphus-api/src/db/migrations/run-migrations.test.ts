import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertForwardOnly,
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  parseMigrationJournal,
  readMigrationJournal,
  runMigrations,
  summariseMigrations,
} from './run-migrations'
import type { MigrationJournal } from './run-migrations'

const entry = (idx: number, tag: string, when: number) => ({
  idx,
  version: '7',
  when,
  tag,
  breakpoints: true,
})

const journalOf = (...entries: ReturnType<typeof entry>[]): MigrationJournal => ({
  version: '7',
  dialect: 'postgresql',
  entries,
})

const filesFor = (journal: MigrationJournal) => journal.entries.map((item) => `${item.tag}.sql`)

describe('parseMigrationJournal', () => {
  it('parses a well-formed journal', () => {
    const journal = parseMigrationJournal(
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '7', when: 1, tag: '0000_a', breakpoints: true }],
      }),
    )
    expect(journal.entries).toHaveLength(1)
    expect(journal.entries[0]?.tag).toBe('0000_a')
  })

  it('rejects a journal that is not the shape the runner relies on', () => {
    expect(() => parseMigrationJournal('[]')).toThrow(/not an object/)
    expect(() => parseMigrationJournal('{"version":"7","dialect":"postgresql"}')).toThrow(/entries/)
    expect(() =>
      parseMigrationJournal('{"version":"7","dialect":"postgresql","entries":[{"idx":0}]}'),
    ).toThrow(/idx or when/)
  })
})

describe('assertForwardOnly', () => {
  it('accepts a forward-only folder', () => {
    const journal = journalOf(entry(0, '0000_a', 1), entry(1, '0001_b', 2))
    expect(() => {
      assertForwardOnly(journal, [...filesFor(journal), 'meta'])
    }).not.toThrow()
  })

  it.each(['0001_down.sql', '0001_rollback_users.sql', '0001_revert-thing.sql', '0001_undo.sql'])(
    'refuses to run when %s is present (FR-010)',
    (rollback) => {
      const journal = journalOf(entry(0, '0000_a', 1))
      expect(() => {
        assertForwardOnly(journal, [...filesFor(journal), rollback])
      }).toThrow(/forward-only/)
    },
  )

  it('does not mistake a legitimate name that merely contains the letters', () => {
    const journal = journalOf(entry(0, '0000_add_shutdown_reason', 1))
    expect(() => {
      assertForwardOnly(journal, filesFor(journal))
    }).not.toThrow()
  })

  it('rejects a journal whose timestamps are not strictly increasing', () => {
    const journal = journalOf(entry(0, '0000_a', 5), entry(1, '0001_b', 5))
    expect(() => {
      assertForwardOnly(journal, filesFor(journal))
    }).toThrow(/strictly increasing/)
  })

  it('rejects a duplicated tag', () => {
    const journal = journalOf(entry(0, '0000_a', 1), entry(1, '0000_a', 2))
    expect(() => {
      assertForwardOnly(journal, filesFor(journal))
    }).toThrow(/duplicate tag/)
  })

  it('rejects an idx that does not match its position, which would reorder application', () => {
    const journal = journalOf(entry(0, '0000_a', 1), entry(5, '0001_b', 2))
    expect(() => {
      assertForwardOnly(journal, filesFor(journal))
    }).toThrow(/expected 1/)
  })

  it('rejects a journal entry whose SQL file is missing', () => {
    const journal = journalOf(entry(0, '0000_a', 1))
    expect(() => {
      assertForwardOnly(journal, [])
    }).toThrow(/not on disk/)
  })

  it('rejects a SQL file the journal does not know about, which would never be applied', () => {
    const journal = journalOf(entry(0, '0000_a', 1))
    expect(() => {
      assertForwardOnly(journal, [...filesFor(journal), '0001_orphan.sql'])
    }).toThrow(/absent from the journal/)
  })
})

describe('summariseMigrations', () => {
  const journal = journalOf(entry(0, '0000_a', 10), entry(1, '0001_b', 20))

  it('reports everything as outstanding against a fresh database', () => {
    expect(summariseMigrations(journal, [])).toStrictEqual({
      applied: ['0000_a', '0001_b'],
      alreadyApplied: [],
    })
  })

  it('reports nothing outstanding when the database is up to date', () => {
    expect(summariseMigrations(journal, [10, 20])).toStrictEqual({
      applied: [],
      alreadyApplied: ['0000_a', '0001_b'],
    })
  })

  it('reports only the gap when the database is partly migrated', () => {
    expect(summariseMigrations(journal, [10])).toStrictEqual({
      applied: ['0001_b'],
      alreadyApplied: ['0000_a'],
    })
  })
})

describe('the migrations shipped in this package', () => {
  it('reads its own journal and passes its own forward-only check', async () => {
    const journal = await readMigrationJournal()
    expect(journal.dialect).toBe('postgresql')
    expect(journal.entries.length).toBeGreaterThan(0)
    expect(() => {
      assertForwardOnly(journal, [] as string[])
    }).toThrow()
    assertForwardOnly(journal, await readdir(MIGRATIONS_FOLDER))
  })

  it('creates the citext extension before any table that uses it', async () => {
    const journal = await readMigrationJournal()
    const first = journal.entries[0]
    expect(first).toBeDefined()
    const sql = await readFile(path.join(MIGRATIONS_FOLDER, `${first.tag}.sql`), 'utf8')
    expect(sql.indexOf('CREATE EXTENSION IF NOT EXISTS citext')).toBeGreaterThanOrEqual(0)
    expect(sql.indexOf('CREATE EXTENSION IF NOT EXISTS citext')).toBeLessThan(
      sql.indexOf('"citext" NOT NULL'),
    )
  })

  it('keeps drizzle bookkeeping out of the public schema', () => {
    expect(MIGRATIONS_SCHEMA).toBe('drizzle')
    expect(MIGRATIONS_TABLE).toBe('__drizzle_migrations')
  })

  it('treats a folder with no journal as nothing to do rather than an error', async () => {
    const journal = await readMigrationJournal(path.join(MIGRATIONS_FOLDER, 'does-not-exist'))
    expect(journal.entries).toStrictEqual([])
  })
})

/**
 * The one test that needs a live database. Skipped — not failed — when
 * `SISYPHUS_TEST_DATABASE_URL` is absent, so `vitest run` is green on a machine with no Postgres.
 */
const liveDatabaseUrl = process.env['SISYPHUS_TEST_DATABASE_URL']

describe.skipIf(liveDatabaseUrl === undefined || liveDatabaseUrl === '')(
  'runMigrations against a live database',
  () => {
    it('applies every migration and is idempotent on a second run', async () => {
      const connectionString = liveDatabaseUrl ?? ''
      const first = await runMigrations({ connectionString })
      expect(first.applied.length + first.alreadyApplied.length).toBeGreaterThan(0)

      const second = await runMigrations({ connectionString })
      expect(second.applied).toStrictEqual([])
      expect(second.alreadyApplied.length).toBe(first.applied.length + first.alreadyApplied.length)
    }, 60_000)
  },
)
