/**
 * Naming, secret and IAM-policy helpers shared by every primitive in this
 * package.
 *
 * Nothing here reaches for a Pulumi or SST global. `getResourceIdentifier`
 * takes the project/stack pair it formats and `getEnvSecret` takes the wrapping
 * function it applies, so both are ordinary functions that can be exercised
 * without an SST-generated `.sst/platform/config.d.ts` and without cloud
 * access. See the note at the top of `index.ts` for why that matters.
 */

/** The project and stack a set of resources is being named under. */
export interface ResourceScope {
  /** Pulumi project name — `$app.name` / `pulumi.getProject()` at the call site. */
  readonly project: string
  /** SST stage name including any suffix — `$app.stage` / `pulumi.getStack()`. */
  readonly stack: string
}

/**
 * Formats a resource name in the standard `{project}-{stack}-{name}` shape, so
 * every stage is isolated inside a single AWS account by naming alone.
 *
 * @example
 * getResourceIdentifier({ project: 'sisyphus', stack: 'staging' }, 'logs')
 * // → 'sisyphus-staging-logs'
 */
export const getResourceIdentifier = (scope: ResourceScope, name: string): string =>
  `${scope.project}-${scope.stack}-${name}`

/**
 * The single function `getEnvSecret` needs from Pulumi — `pulumi.secret`.
 * Declared structurally so this package never imports `@pulumi/pulumi`; the
 * real function is handed in from `sst.config.ts`.
 */
export interface SecretWrapper<TSecret> {
  (value: string): TSecret
}

export interface GetEnvSecretOptions {
  /**
   * Return the raw string rather than a wrapped secret. Reserved for the
   * bootstrap-time values that cannot be secrets, because they are needed in
   * order to deploy at all.
   */
  readonly dangerousClearText?: boolean
}

/**
 * Narrows a process environment to a total record of the values that are
 * actually set.
 *
 * `process.env` types every value as possibly `undefined`, which
 * {@link getEnvSecret} cannot consume — and quietly treating an unset variable
 * as an empty string is exactly the failure `getEnvSecret` exists to prevent.
 * Dropping unset keys here means the variable is missing from the record, so the
 * error names it.
 */
export const readEnvRecord = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  )

  return Object.fromEntries(entries)
}

/**
 * Reads a deploy-time value out of an environment record, wrapping it as a
 * Pulumi secret by default so it does not appear in plain text in stack state.
 *
 * Throws naming the missing variable rather than letting an empty string reach
 * a resource argument, which is the deploy-time counterpart of what
 * `createSafeEnv` does at boot.
 */
export const getEnvSecret = <TSecret, TSecrets extends Record<string, string>>(
  wrapSecret: SecretWrapper<TSecret>,
  secrets: TSecrets,
  key: keyof TSecrets,
  options: GetEnvSecretOptions = {},
): TSecret | string => {
  const value = secrets[key]

  if (!value) {
    throw new Error(`Missing environment variable: ${String(key)}`)
  }

  return options.dangerousClearText === true ? value : wrapSecret(value)
}

/**
 * IAM policy documents are expressed as plain, serialisable data with AWS's own
 * PascalCase keys. Every identifier is a plain `string`: a Pulumi caller holding
 * an `Output<string>` resolves it with `.apply()` before calling a builder, which
 * keeps these types free of any Pulumi generic and keeps the builders pure.
 */
export interface PolicyPrincipal {
  readonly Federated?: readonly string[]
  readonly Service?: readonly string[]
}

export type PolicyConditionOperator = Readonly<Record<string, readonly string[] | string>>

export interface PolicyStatement {
  readonly Sid?: string
  readonly Effect: 'Allow' | 'Deny'
  readonly Principal?: PolicyPrincipal
  readonly Action: readonly string[]
  readonly Resource?: readonly string[]
  readonly Condition?: Readonly<Record<string, PolicyConditionOperator>>
}

export interface PolicyDocument {
  readonly Version: '2012-10-17'
  readonly Statement: readonly PolicyStatement[]
}

/** The only IAM policy language version AWS accepts for new policies. */
export const POLICY_VERSION = '2012-10-17' as const
