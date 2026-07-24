import {
  // We are declaring this rule here
  // eslint-disable-next-line @chalkboard/enforce-safe-env
  createEnv,
  type EnvOptions,
  type StandardSchemaV1,
  type StandardSchemaDictionary,
} from '@t3-oss/env-core'
import { ZodError, type ZodIssue } from 'zod/v3'
import { fromZodError } from 'zod-validation-error/v3'

/**
 * When true, createEnv() will skip all environment variable validation.
 * Reads process.env.SKIP_ENV_VALIDATION at import time.
 * Primarily consumed internally by createSafeEnv(); exported for advanced use cases.
 */
export const skipValidation = process.env.SKIP_ENV_VALIDATION === 'true'

/**
 * Formats an array of Zod issues into a human-readable error message.
 * Pure function — does not throw or produce console output.
 */
export const formatEnvErrors = (issues: readonly StandardSchemaV1.Issue[]): string => {
  const zodError = new ZodError(issues as ZodIssue[])
  const validationError = fromZodError(zodError, {
    prefix: 'Invalid environment variables',
    issueSeparator: '; ',
  })
  return validationError.message
}

/**
 * Ready-to-use onValidationError handler for createEnv().
 * Logs the formatted message to console.error with a visual prefix,
 * then throws an Error containing the same message.
 */
export const onValidationError = (issues: readonly StandardSchemaV1.Issue[]): never => {
  const message = formatEnvErrors(issues)
  console.error(`❌ ${message}`)
  throw new Error(message)
}

/**
 * Options that createSafeEnv bakes in automatically.
 * Consumers cannot override these.
 */
type BakedInOptions = 'onValidationError' | 'emptyStringAsUndefined' | 'skipValidation'

/**
 * Wrapper around createEnv() that automatically applies:
 * - onValidationError: pretty error handler using zod-validation-error
 * - emptyStringAsUndefined: true
 * - skipValidation: process.env.SKIP_ENV_VALIDATION === 'true'
 *
 * Consumers pass only their schema config (server, client, runtimeEnv, etc.).
 */
export const createSafeEnv = <
  TPrefix extends string | undefined,
  TServer extends StandardSchemaDictionary = NonNullable<unknown>,
  TClient extends StandardSchemaDictionary = NonNullable<unknown>,
  TShared extends StandardSchemaDictionary = NonNullable<unknown>,
  const TExtends extends Array<Record<string, unknown>> = [],
>(
  opts: Omit<EnvOptions<TPrefix, TServer, TClient, TShared, TExtends>, BakedInOptions>,
) =>
  createEnv({
    ...opts,
    emptyStringAsUndefined: true,
    skipValidation,
    onValidationError,
  } as EnvOptions<TPrefix, TServer, TClient, TShared, TExtends>)
