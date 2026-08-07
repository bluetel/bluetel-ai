import type { GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager'
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

/**
 * The secret seam — the board credential, read at tick time (T054, FR-072).
 *
 * `integrations.credential_secret_arn` is an ARN and nothing else: the panel writes it and never
 * reads it back (FR-098), and the tick resolves it to a credential the moment it needs one. This is
 * the resolution, and it is one method wide because that is all the control plane does with Secrets
 * Manager — it never writes a secret, never rotates one and never lists them.
 *
 * **Nothing is cached.** A credential held between invocations would outlive its rotation, and a
 * warm Lambda container can live for hours. The cost of reading per tick is one API call against a
 * cadence measured in minutes.
 *
 * As with every other module in this directory, no client is constructed here: the adapter is
 * handed one, so importing the barrel reaches no account.
 */

export interface SecretReader {
  /**
   * The secret's string value.
   *
   * @throws If the secret does not exist, or holds only binary. A tick that continued with an empty
   *   credential would authenticate as nobody and report a board-side authorisation failure, which
   *   sends whoever reads it looking at Jira rather than at the configuration.
   */
  readonly read: (secretId: string) => Promise<string>
}

/** The subset of `SecretsManagerClient` this adapter uses. */
export interface SecretsCommandSender {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>
}

export const createSecretsManagerReader = (options: {
  readonly client: SecretsCommandSender
}): SecretReader => {
  const { client } = options

  return {
    read: async (secretId) => {
      const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
      const value = output.SecretString

      if (value === undefined || value === '') {
        throw new Error(
          `Secret ${secretId} holds no string value. An integration credential must be stored as a string secret; a binary one cannot be sent as a request header.`,
        )
      }

      return value
    },
  }
}
