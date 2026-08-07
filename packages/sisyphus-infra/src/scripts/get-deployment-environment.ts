/**
 * Where a stage's deploy-time configuration lives, and how it is read.
 *
 * ---------------------------------------------------------------------------
 * Why the parameter store and not a committed file
 * ---------------------------------------------------------------------------
 * A bootstrap has to run when no stack exists, so it cannot read a stack output;
 * and the values it needs include credentials, so it cannot read a committed
 * file. Parameter Store is reachable with the ambient credential chain before
 * anything has been deployed, which is the only source that satisfies both
 * (FR-202).
 *
 * ---------------------------------------------------------------------------
 * Why one entry per deployable rather than one per stage
 * ---------------------------------------------------------------------------
 * Each deployable's bootstrap stack *creates* its entry, and two stacks cannot
 * own one resource. A single shared `/sisyphus/<stage>/env` would be declared
 * three times and fought over on every bootstrap. Splitting by deployable gives
 * each entry exactly one owner, and the plain stage still comes from
 * `getPlainStage`, so `production`, `production-bootstrap` and
 * `production-website` all read and write the same entry (FR-202).
 *
 * Nothing here runs at import time: the SSM client is constructed inside the
 * call. These modules are loaded by CI scripts and by deployment configs, and a
 * client built at module scope would demand credentials from every importer,
 * including the one whose whole job is to work without them.
 */

import { getPlainStage } from '../get-plain-stage'

/**
 * The deployables that carry their own configuration entry. Typed as a closed
 * set so a mistyped name fails to compile rather than reading an absent
 * parameter at deploy time.
 */
export const DEPLOYABLE_KEYS = ['admin', 'control-plane', 'executor'] as const

export type DeployableKey = (typeof DEPLOYABLE_KEYS)[number]

/**
 * The Parameter Store path holding one deployable's deploy-time environment for
 * a stage, in the same `/sisyphus/<stage>/...` shape as every other entry.
 *
 * @example
 * getEnvParameterName('admin', 'production-bootstrap')
 * // → '/sisyphus/production/admin/env'
 */
export const getEnvParameterName = (deployable: DeployableKey, sstStage: string): string =>
  `/sisyphus/${getPlainStage(sstStage)}/${deployable}/env`

/**
 * Parses a `.env`-shaped blob into a record.
 *
 * Deliberately forgiving about layout — blank lines, `#` comments and quoted
 * values are all normal in an operator-edited parameter — and deliberately
 * unforgiving about the split: only the **first** `=` separates key from value,
 * so a connection URL or a base64 secret containing `=` survives intact. A
 * naive `split('=')` truncates exactly those two, and the truncation is silent.
 */
export const parseEnvContent = (content: string): Record<string, string> => {
  const parsed: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')

    if (separator === -1) {
      continue
    }

    const key = trimmed.slice(0, separator).trim()

    if (key === '') {
      continue
    }

    parsed[key] = unquote(trimmed.slice(separator + 1).trim())
  }

  return parsed
}

const unquote = (value: string): string => {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))

  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}

export interface DeploymentEnvironmentOptions {
  readonly deployable: DeployableKey
  /** SST stage name; the plain stage is derived from it. */
  readonly sstStage: string
  readonly region: string
  /**
   * Answer `{}` instead of throwing when the entry does not exist. Reserved for
   * the first bootstrap of a stage, which runs *before* the entry it will create
   * exists.
   */
  readonly optional?: boolean
}

/**
 * Reads a deployable's deploy-time environment for a stage out of Parameter
 * Store, decrypted, as a record.
 *
 * Uses the ambient credential chain — a CI job that has already assumed the
 * deploy role, or a developer's local profile — so it works before any stack
 * exists.
 */
export const getDeploymentEnvironment = async (
  options: DeploymentEnvironmentOptions,
): Promise<Record<string, string>> => {
  const { GetParameterCommand, SSMClient } = await import('@aws-sdk/client-ssm')

  const name = getEnvParameterName(options.deployable, options.sstStage)
  const ssm = new SSMClient({ region: options.region })

  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    const value = result.Parameter?.Value

    if (value === undefined || value === '') {
      throw new Error(`Parameter "${name}" exists but is empty.`)
    }

    return parseEnvContent(value)
  } catch (cause) {
    if (options.optional === true) {
      return {}
    }

    // The underlying message is folded into the text rather than attached as a
    // `cause`: this surfaces in a CI log, where nothing unwraps a cause chain.
    throw new Error(
      `Could not read deploy-time configuration from "${name}". Run the bootstrap for this ` +
        `stage first, then populate the parameter with the deployable's environment. ` +
        `The underlying failure was: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}
