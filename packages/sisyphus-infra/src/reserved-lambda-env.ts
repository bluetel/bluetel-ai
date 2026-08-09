/**
 * Environment keys the Lambda runtime injects itself. Declaring one in a
 * function's `environment` is rejected at deploy time with
 * `InvalidParameterValueException`, not silently ignored — so every construct
 * that builds a Lambda environment from a config object must filter these out
 * rather than let an upstream key collide with one.
 */
export const RESERVED_LAMBDA_ENV_KEYS: readonly string[] = ['AWS_REGION']

/**
 * Drops any reserved key from an environment record, keeping every other entry
 * (including its `Output`/`Input` wrapper) untouched.
 */
export const omitReservedLambdaEnv = <TValue>(
  environment: Readonly<Record<string, TValue>>,
): Record<string, TValue> => {
  const entries = Object.entries(environment).filter(
    ([key]) => !RESERVED_LAMBDA_ENV_KEYS.includes(key),
  )

  return Object.fromEntries(entries)
}
