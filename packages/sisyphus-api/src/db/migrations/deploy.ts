import path from 'node:path'
import { fileURLToPath } from 'node:url'

// From the package's `./lib` and `./sst-app` subpaths, not its root — the root barrel re-exports
// every construct in the package, several of which reach for Pulumi/SST's ambient `aws`/`sst`/
// `$util` globals that only exist inside an SST app's own typecheck. `sisyphus-api` is a plain
// library with no such globals declared, so pulling in the whole barrel breaks its typecheck even
// though these two values never touch a provider.
import { getConnectionUrlParameterName } from '@bluetel-ai/sisyphus-infra/lib'
import { DEFAULT_AWS_REGION } from '@bluetel-ai/sisyphus-infra/sst-app'

import { type BastionTunnel, openBastionTunnel } from './bastion-tunnel'
import { DATABASE_URL_VARIABLE, runMigrateCommand } from './cli'
import { installPublicDnsFallback } from './dns-fallback'
import { findMonorepoRoot } from './find-monorepo-root'

/**
 * `nx run sisyphus-api:migrate --configuration=staging|production` — migrate a deployed stage from
 * a laptop rather than `SISYPHUS_DATABASE_URL` pointed at one by hand.
 *
 * A deployed stage's database has no route from outside its VPC (FR-072's `publiclyAccessible:
 * false`); this opens the `sst tunnel` that reaches it through the shared bastion, reads the
 * stage's connection URL out of Parameter Store, then runs the same {@link runMigrateCommand} a
 * personal stage uses — the two paths only differ in how `SISYPHUS_DATABASE_URL` gets set.
 *
 * Requires AWS credentials for the target account to already be active in the shell (e.g.
 * `AWS_PROFILE`): this never selects or assumes one, the same way `runMigrateCommand` never
 * guesses a database.
 */

export const STAGE_VARIABLE = 'SISYPHUS_STAGE'

const ADMIN_APP_RELATIVE_PATH = path.join('apps', 'sisyphus-admin')

const readConnectionUrlFromSsm = async (parameterName: string, region: string): Promise<string> => {
  const { GetParameterCommand, SSMClient } = await import('@aws-sdk/client-ssm')
  const ssm = new SSMClient({ region })
  const result = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  )
  const value = result.Parameter?.Value

  if (value === undefined || value === '') {
    throw new Error(`Parameter "${parameterName}" is missing or empty.`)
  }

  return value
}

export interface DeployMigrateOptions {
  readonly stage: string
  readonly region?: string
  readonly log?: (message: string) => void
  /** The monorepo root, for locating `apps/sisyphus-admin`. Discovered from disk by default. */
  readonly monorepoRoot?: string
  readonly readConnectionUrl?: (parameterName: string, region: string) => Promise<string>
  readonly openTunnel?: (options: {
    readonly stage: string
    readonly adminAppDir: string
  }) => Promise<BastionTunnel>
  readonly installDnsFallback?: () => () => void
  /** Overridable so a test can assert on what would be migrated without opening a real pool. */
  readonly runMigrate?: typeof runMigrateCommand
}

export const runDeployMigrateCommand = async (options: DeployMigrateOptions): Promise<string> => {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`))
  const region =
    options.region ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    DEFAULT_AWS_REGION
  const readConnectionUrl = options.readConnectionUrl ?? readConnectionUrlFromSsm
  const openTunnel = options.openTunnel ?? openBastionTunnel
  const installDnsFallback = options.installDnsFallback ?? installPublicDnsFallback
  const runMigrate = options.runMigrate ?? runMigrateCommand

  const monorepoRoot =
    options.monorepoRoot ?? findMonorepoRoot(path.dirname(fileURLToPath(import.meta.url)))
  const adminAppDir = path.join(monorepoRoot, ADMIN_APP_RELATIVE_PATH)

  log(`Opening a tunnel to stage "${options.stage}" through its bastion...`)
  const tunnel = await openTunnel({ stage: options.stage, adminAppDir })
  const restoreDns = installDnsFallback()

  try {
    const parameterName = getConnectionUrlParameterName(options.stage)
    log(`Reading the database connection URL from "${parameterName}"...`)
    const connectionString = await readConnectionUrl(parameterName, region)

    return await runMigrate({ env: { [DATABASE_URL_VARIABLE]: connectionString }, log })
  } finally {
    restoreDns()
    tunnel.close()
  }
}

export interface DeployMigrateCliDependencies {
  readonly env?: Record<string, string | undefined>
  readonly log?: (message: string) => void
}

/**
 * Reads exactly one variable, for the same reason `cli.ts` does: pointing a migration at the wrong
 * stage should take a deliberate act, not a mistyped flag.
 */
export const runDeployMigrateCliCommand = async (
  dependencies: DeployMigrateCliDependencies = {},
): Promise<string> => {
  const env = dependencies.env ?? process.env
  const stage = env[STAGE_VARIABLE]?.trim()

  if (stage === undefined || stage === '') {
    throw new Error(`${STAGE_VARIABLE} is not set. Set it to the stage to migrate, e.g. "staging".`)
  }

  return runDeployMigrateCommand({ stage, log: dependencies.log })
}

/* c8 ignore start -- entry point, exercised by the nx target rather than by a unit test */
if (process.argv[1]?.endsWith('deploy.ts')) {
  void runDeployMigrateCliCommand().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
/* c8 ignore stop */
