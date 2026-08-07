/**
 * The one PostgreSQL instance per stage, plus the Parameter Store entry the
 * deployables read their connection URL from.
 *
 * Publishing the URL to a parameter rather than threading it through stack
 * outputs is what keeps `sisyphus-api` the only member that ever holds a
 * database credential: the panel and the control plane read one parameter, and
 * the executor is never granted the parameter at all.
 */

import { getResourceIdentifier, type ResourceScope } from './lib'

const PRODUCTION_STAGE = 'production'

export interface DatabaseConfig {
  readonly scope: ResourceScope
  /** Plain stage name — pass `getPlainStage($app.stage)`, not the suffixed stack. */
  readonly stage: string
  readonly instanceClass?: string
  readonly allocatedStorageGb?: number
  readonly engineVersion?: string
}

export interface DatabaseSpecification {
  readonly identifier: string
  readonly engine: 'postgres'
  readonly engineVersion: string
  readonly instanceClass: string
  readonly allocatedStorageGb: number
  /** Always true — FR-072 forbids platform credentials and data at rest in the clear. */
  readonly storageEncrypted: true
  /** Always false — the control plane and panel reach it from inside the VPC only. */
  readonly publiclyAccessible: false
  readonly multiAvailabilityZone: boolean
  readonly backupRetentionDays: number
  readonly deletionProtection: boolean
  readonly databaseName: string
  /** Parameter Store path the connection URL is published to. */
  readonly connectionUrlParameterName: string
}

/**
 * The Parameter Store path a stage's connection URL is published to. Built from
 * the plain stage so `<stage>-bootstrap` and `<stage>-website` read and write
 * the same entry.
 */
export const getConnectionUrlParameterName = (stage: string): string =>
  `/sisyphus/${stage}/database/connection-url`

/**
 * Pure description of the instance. Production gets a standby, a fortnight of
 * backups and deletion protection; every other stage is disposable by design,
 * because a personal stage that cannot be torn down is a stage nobody deletes.
 */
export const buildDatabaseSpecification = (config: DatabaseConfig): DatabaseSpecification => {
  const isProduction = config.stage === PRODUCTION_STAGE

  return {
    identifier: getResourceIdentifier(config.scope, 'database'),
    engine: 'postgres',
    engineVersion: config.engineVersion ?? '17.4',
    instanceClass: config.instanceClass ?? (isProduction ? 'db.t4g.small' : 'db.t4g.micro'),
    allocatedStorageGb: config.allocatedStorageGb ?? (isProduction ? 50 : 20),
    storageEncrypted: true,
    publiclyAccessible: false,
    multiAvailabilityZone: isProduction,
    backupRetentionDays: isProduction ? 14 : 1,
    deletionProtection: isProduction,
    databaseName: 'sisyphus',
    connectionUrlParameterName: getConnectionUrlParameterName(config.stage),
  }
}

export interface ParameterSpecification<TValue> {
  readonly name: string
  /** Always `SecureString` — the value is a credential (FR-072). */
  readonly type: 'SecureString'
  readonly value: TValue
  readonly description: string
}

/**
 * The narrow slice of the SST/Pulumi provider surface this primitive needs.
 * `sst.config.ts` supplies constructors closing over the real `sst`/`aws`
 * globals; nothing in this package imports them.
 */
export interface DatabaseProvider<TInstance, TParameter, TValue> {
  readonly createInstance: (name: string, specification: DatabaseSpecification) => TInstance
  readonly createParameter: (
    name: string,
    specification: ParameterSpecification<TValue>,
  ) => TParameter
}

export interface CreatedDatabase<TInstance, TParameter> {
  readonly specification: DatabaseSpecification
  readonly instance: TInstance
  readonly connectionUrlParameter: TParameter
}

/**
 * Creates the instance and publishes its connection URL.
 *
 * `resolveConnectionUrl` exists because the URL is only knowable from the
 * created instance — a Pulumi caller returns an `Output<string>` from it, and a
 * test returns a plain string.
 */
export const createDatabase = <TInstance, TParameter, TValue>(
  provider: DatabaseProvider<TInstance, TParameter, TValue>,
  config: DatabaseConfig,
  resolveConnectionUrl: (instance: TInstance) => TValue,
): CreatedDatabase<TInstance, TParameter> => {
  const specification = buildDatabaseSpecification(config)
  const instance = provider.createInstance(specification.identifier, specification)

  const connectionUrlParameter = provider.createParameter(
    getResourceIdentifier(config.scope, 'database-connection-url'),
    {
      name: specification.connectionUrlParameterName,
      type: 'SecureString',
      value: resolveConnectionUrl(instance),
      description: `Sisyphus PostgreSQL connection URL for stage "${config.stage}"`,
    },
  )

  return { specification, instance, connectionUrlParameter }
}
