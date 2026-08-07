/**
 * The one PostgreSQL instance per stage, plus the Parameter Store entry the
 * deployables read their connection URL from.
 *
 * Publishing the URL to a parameter rather than threading it through stack
 * outputs is what keeps `sisyphus-api` the only member that ever holds a
 * database credential: the panel and the control plane read one parameter, and
 * the executor is never granted the parameter at all.
 *
 * Both stages run the smallest instance class and storage AWS allows, with no
 * standby, to keep cost minimal. Production still gets a fortnight of backups
 * and deletion protection; every other stage is disposable by design, because
 * a personal stage that cannot be torn down is a stage nobody deletes.
 */

import { getConnectionUrlParameterName, getResourceIdentifier, type ResourceScope } from './lib'
import { isProductionStage } from './sst-app'

/** The database, and the role the panel and the control plane connect as. */
const DATABASE_NAME = 'sisyphus'

const DEFAULT_ENGINE_VERSION = '17.4'

export interface DatabaseConfig {
  readonly scope: ResourceScope
  /** Plain stage name — pass `scope.stack`, not the suffixed SST stage. */
  readonly stage: string
  readonly username?: string
  /**
   * The master password, in clear text.
   *
   * This is the single, named exception FR-202 allows: the value is needed in
   * order to *construct* the instance and to compose the connection URL, so it
   * cannot arrive already wrapped. Both places it lands — the instance argument
   * and the parameter — wrap it before it reaches stack state.
   */
  readonly password: string
  readonly instanceClass?: string
  readonly allocatedStorageGb?: number
  readonly engineVersion?: string
}

export interface Database {
  readonly instance: aws.rds.Instance
  /** Secret-wrapped, and only knowable once the instance has an endpoint. */
  readonly connectionUrl: $util.Output<string>
  readonly connectionUrlParameter: aws.ssm.Parameter
  /** The path the URL was published to, for a caller reporting it as an output. */
  readonly connectionUrlParameterName: string
}

export const createDatabase = (config: DatabaseConfig): Database => {
  const isProduction = isProductionStage(config.stage)
  const identifier = getResourceIdentifier(config.scope, 'database')
  const username = config.username ?? DATABASE_NAME

  const instance = new aws.rds.Instance(identifier, {
    identifier,
    engine: 'postgres',
    engineVersion: config.engineVersion ?? DEFAULT_ENGINE_VERSION,
    instanceClass: config.instanceClass ?? 'db.t4g.micro',
    allocatedStorage: config.allocatedStorageGb ?? 20,
    // FR-072 forbids platform credentials and data at rest in the clear.
    storageEncrypted: true,
    // The control plane and panel reach it from inside the VPC only.
    publiclyAccessible: false,
    multiAz: false,
    backupRetentionPeriod: isProduction ? 14 : 1,
    deletionProtection: isProduction,
    dbName: DATABASE_NAME,
    username,
    password: $util.secret(config.password),
    skipFinalSnapshot: !isProduction,
  })

  const connectionUrl = $util.secret(
    instance.endpoint.apply(
      (endpoint) =>
        `postgres://${username}:${encodeURIComponent(config.password)}@${endpoint}/${DATABASE_NAME}`,
    ),
  )

  const connectionUrlParameterName = getConnectionUrlParameterName(config.stage)

  const connectionUrlParameter = new aws.ssm.Parameter(
    getResourceIdentifier(config.scope, 'database-connection-url'),
    {
      name: connectionUrlParameterName,
      // Always `SecureString` — the value is a credential (FR-072).
      type: 'SecureString',
      value: connectionUrl,
      description: `Sisyphus PostgreSQL connection URL for stage "${config.stage}"`,
    },
  )

  return { instance, connectionUrl, connectionUrlParameter, connectionUrlParameterName }
}
