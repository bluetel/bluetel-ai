/**
 * The steps between "a GitHub Actions job started" and "a deploy can run":
 * exchange the job's OIDC token for short-lived AWS credentials, then read the
 * stage's configuration out of Parameter Store.
 *
 * ---------------------------------------------------------------------------
 * Why any of this is code rather than a marketplace action
 * ---------------------------------------------------------------------------
 * The role the job assumes is named by {@link getDeployRoleArn}, from the same
 * constant the bootstrap builds the role with (FR-200). An action configured
 * with a hand-written ARN in workflow YAML is the second literal that module
 * exists to prevent.
 *
 * There is no long-lived access key anywhere in this path (FR-068): the token
 * comes from the runner, the credentials expire with the session, and the role
 * will only be handed out to a token whose `sub` claim names the protected
 * branch — a rule enforced by the trust policy in `policies.ts`, not here.
 *
 * Nothing runs at import time. Every AWS client is constructed inside the call
 * that uses it, and every SDK import is dynamic, so a config file that imports
 * this module to read one parameter does not pull three clients into a process
 * that has no credentials.
 */

import type { ResourceScope } from '../lib'

import { getDeployRoleArn } from './deploy-role-name'
import { parseEnvContent } from './get-deployment-environment'

/**
 * Renders whatever was thrown as one line of log text. Every failure in this
 * module ends up in a CI job's output, where a nested `cause` is never unwrapped
 * and an object prints as `[object Object]`.
 */
const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** Short-lived credentials from an assumed role. */
export interface AwsCredentials {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken: string
}

/** The audience the deploy role's trust policy requires on the token. */
const STS_AUDIENCE = 'sts.amazonaws.com'

/**
 * Fetches a GitHub Actions OIDC token for the current job.
 *
 * Requires `permissions: { id-token: write }` on the job; without it the runner
 * sets neither variable and the exchange cannot happen at all, so the error says
 * so rather than reporting a 401 from a URL the reader has never seen.
 */
export const fetchGitHubOidcToken = async (): Promise<string> => {
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL

  if (!requestToken || !requestUrl) {
    throw new Error(
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN and ACTIONS_ID_TOKEN_REQUEST_URL are not set, so no OIDC ' +
        'token can be requested. Add `permissions: { id-token: write }` to the deploy job.',
    )
  }

  const response = await fetch(`${requestUrl}&audience=${STS_AUDIENCE}`, {
    headers: {
      Authorization: `bearer ${requestToken}`,
      Accept: 'application/json; api-version=2.0',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Could not fetch an OIDC token: ${String(response.status)} ${response.statusText}`,
    )
  }

  const body = (await response.json()) as { value?: string }

  if (!body.value) {
    throw new Error('The OIDC token endpoint answered without a token value.')
  }

  return body.value
}

export interface AssumeDeployRoleOptions {
  readonly oidcToken: string
  readonly roleArn: string
  readonly region: string
  /** Appears in CloudTrail against every call the deploy makes. */
  readonly sessionName: string
}

/**
 * Exchanges a GitHub OIDC token for credentials on the deploy role.
 *
 * The three credential fields are checked individually because STS types them
 * all as optional; a partially-populated result would otherwise become a client
 * that fails much later with an unrelated authentication error.
 */
export const assumeAwsRoleWithOidc = async (
  options: AssumeDeployRoleOptions,
): Promise<AwsCredentials> => {
  const { AssumeRoleWithWebIdentityCommand, STSClient } = await import('@aws-sdk/client-sts')

  const sts = new STSClient({ region: options.region })

  const result = await sts.send(
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: options.roleArn,
      RoleSessionName: options.sessionName,
      WebIdentityToken: options.oidcToken,
    }),
  )

  const { AccessKeyId, SecretAccessKey, SessionToken } = result.Credentials ?? {}

  if (!AccessKeyId || !SecretAccessKey || !SessionToken) {
    throw new Error(
      `AssumeRoleWithWebIdentity returned incomplete credentials for ${options.roleArn}.`,
    )
  }

  return { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: SessionToken }
}

/**
 * The whole CI credential exchange for one stage: token, role name, session.
 *
 * The role ARN is derived from the stage scope and the account, never passed in,
 * so a workflow cannot point the deploy at a role the bootstrap did not create.
 */
export const assumeDeployRole = async (options: {
  readonly accountId: string
  readonly scope: ResourceScope
  readonly region: string
  readonly sessionName?: string
}): Promise<AwsCredentials> =>
  assumeAwsRoleWithOidc({
    oidcToken: await fetchGitHubOidcToken(),
    roleArn: getDeployRoleArn(options.accountId, options.scope),
    region: options.region,
    sessionName: options.sessionName ?? `sisyphus-${options.scope.stack}-deploy`,
  })

const toSdkCredentials = (credentials: AwsCredentials | undefined) =>
  credentials === undefined
    ? {}
    : {
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
        },
      }

/**
 * Resolves the AWS account the current credentials belong to.
 *
 * Credentials are optional: omitted, the ambient chain is used, which is how a
 * local operator confirms a bootstrap is pointed at the account they think it
 * is before it creates an administrator role there.
 */
export const fetchCallerAccountId = async (
  region: string,
  credentials?: AwsCredentials,
): Promise<string> => {
  const { GetCallerIdentityCommand, STSClient } = await import('@aws-sdk/client-sts')

  const sts = new STSClient({ region, ...toSdkCredentials(credentials) })
  const result = await sts.send(new GetCallerIdentityCommand({}))

  if (!result.Account) {
    throw new Error('GetCallerIdentity answered without an account ID.')
  }

  return result.Account
}

const readParameter = async (
  parameterName: string,
  region: string,
  credentials?: AwsCredentials,
): Promise<string> => {
  const { GetParameterCommand, SSMClient } = await import('@aws-sdk/client-ssm')

  const ssm = new SSMClient({ region, ...toSdkCredentials(credentials) })
  const result = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  )

  const value = result.Parameter?.Value

  if (value === undefined || value === '') {
    throw new Error(`Parameter "${parameterName}" is missing or empty.`)
  }

  return value
}

/**
 * Renders a parameter's contents as the body of a `.env` file, with a header
 * saying where it came from so nobody edits the copy.
 */
export const formatEnvFile = (parameterName: string, content: string): string =>
  `# Generated from the parameter store entry "${parameterName}". Do not edit; do not commit.\n` +
  `${content.trimEnd()}\n`

/**
 * Reads a parameter and writes it to disk as a `.env` file.
 *
 * Used by the build steps that read configuration through a file rather than the
 * process environment. The file is written where the caller says and is expected
 * to be git-ignored.
 */
export const fetchSsmParamToEnvFile = async (options: {
  readonly parameterName: string
  readonly outputPath: string
  readonly region: string
  readonly credentials?: AwsCredentials
}): Promise<void> => {
  const { writeFileSync } = await import('node:fs')

  const content = await readParameter(options.parameterName, options.region, options.credentials)

  writeFileSync(options.outputPath, formatEnvFile(options.parameterName, content))
}

/**
 * Applies `.env`-shaped content to `process.env`, leaving anything already set
 * in place.
 *
 * The precedence matters: a deploy config loads the stage's parameter and then
 * an operator's `AWS_PROFILE` or a workflow's `AWS_REGION` must still win, or a
 * one-off override is silently ignored.
 */
export const applyEnvContent = (content: string): void => {
  for (const [key, value] of Object.entries(parseEnvContent(content))) {
    process.env[key] ??= value
  }
}

/**
 * Reads a parameter and merges it into `process.env` without touching disk.
 *
 * This is the form a deployment config uses: it runs inside `app()` / `run()`,
 * so the values land before anything that reads them is imported.
 */
export const fetchSsmParamToProcessEnv = async (options: {
  readonly parameterName: string
  readonly region: string
  readonly credentials?: AwsCredentials
  /**
   * Return `false` rather than throwing when the parameter is absent. Reserved
   * for the first bootstrap of a stage, which necessarily runs before the entry
   * it creates exists.
   */
  readonly optional?: boolean
}): Promise<boolean> => {
  try {
    applyEnvContent(await readParameter(options.parameterName, options.region, options.credentials))

    return true
  } catch (cause) {
    if (options.optional === true) {
      return false
    }

    // The underlying message is folded into the text rather than attached as a
    // `cause`: this surfaces in a CI log, where nothing unwraps a cause chain.
    throw new Error(
      `Could not load deploy-time configuration from "${options.parameterName}": ` +
        describeCause(cause),
    )
  }
}
