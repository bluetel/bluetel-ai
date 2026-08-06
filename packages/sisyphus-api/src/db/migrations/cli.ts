import { runMigrations } from './run-migrations'

/**
 * `nx run sisyphus-api:migrate` — apply outstanding migrations and stop.
 *
 * This is a standalone command, not a deploy step (FR-010): it can be pointed at any stage,
 * re-run safely, and run before or independently of anything being deployed. It reads exactly one
 * variable so that pointing it at the wrong database takes a deliberate act.
 */

export const DATABASE_URL_VARIABLE = 'SISYPHUS_DATABASE_URL'

export interface MigrateCommandDependencies {
  readonly env?: Record<string, string | undefined>
  readonly log?: (message: string) => void
}

/**
 * Run the command. Resolves with a human-readable summary; rejects with a message naming the
 * missing variable rather than failing later with a connection error that does not say why.
 */
export const runMigrateCommand = async (
  dependencies: MigrateCommandDependencies = {},
): Promise<string> => {
  const env = dependencies.env ?? process.env
  const log =
    dependencies.log ??
    ((message: string) => {
      process.stdout.write(`${message}\n`)
    })

  const connectionString = env[DATABASE_URL_VARIABLE]?.trim()
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      `${DATABASE_URL_VARIABLE} is not set. Set it to the connection string of the database to migrate; this command never guesses a default.`,
    )
  }

  log(`Applying migrations to ${connectionString.replace(/\/\/[^@]*@/, '//***@')}`)
  const report = await runMigrations({ connectionString })

  const summary =
    report.applied.length === 0
      ? `Already up to date (${String(report.alreadyApplied.length)} migrations applied previously).`
      : `Applied ${String(report.applied.length)} migration(s): ${report.applied.join(', ')}`
  log(summary)
  return summary
}

/* c8 ignore start -- entry point, exercised by the nx target rather than by a unit test */
if (process.argv[1].endsWith('cli.ts')) {
  void runMigrateCommand().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
/* c8 ignore stop */
