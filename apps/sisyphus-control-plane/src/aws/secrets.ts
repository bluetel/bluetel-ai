import type {
  CreateSecretCommandOutput,
  GetSecretValueCommandOutput,
  PutSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager'
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

/**
 * The secret seam — the only place credential material is stored or fetched (T054, FR-072, R8).
 *
 * Two callers share it. The tick resolves `integrations.credential_secret_arn` to a board credential
 * at the moment it needs one: the panel writes that ARN and never reads it back (FR-098). The
 * credential pool creates one secret per agent credential and puts a new value through it whenever a
 * login produces fresh material (R8). Postgres holds the identifier and never the material, which is
 * what makes FR-011 a fact about where things live rather than a rule people have to remember.
 *
 * Three methods, and deliberately no more. No `list`, because the pool enumerates credentials from
 * its own table, and a seam that could list them would quietly make Secrets Manager a second
 * register of which seats exist — two registers that can disagree. No `delete`: FR-005 already
 * refuses to remove a credential once a lease has referenced it, and where a credential does
 * eventually go away, material nothing points at is a far smaller problem than an identifier
 * pointing at nothing. No rotation schedule, because rotation here is a login performed by an agent,
 * not a Lambda that AWS can call on a timer.
 *
 * **Nothing is cached, on either path.** The read side has never held a value between invocations: a
 * warm Lambda container lives for hours, and a credential carried across one outlives its own
 * rotation — the precise failure this pool exists to prevent. The write side inherits the rule and
 * sharpens it. `write` returns only once Secrets Manager holds the new value, and every read is a
 * fresh `GetSecretValue`, so the first read after a rotation cannot hand back the material the
 * rotation just replaced. A cache here would not be an optimisation with a staleness window; it
 * would be a holder authenticating with a credential the board has already invalidated, surfacing as
 * an authorisation error somewhere far from the cause. The cost of not caching is one API call per
 * tick, against a cadence measured in minutes.
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
  /**
   * Store new material under `name`, resolving to the secret's ARN — the identifier the caller
   * records against the credential row, and the only handle it should keep.
   *
   * The name is chosen by the caller and never derived here: which credential a secret belongs to is
   * the pool's business, and a naming scheme buried in an AWS adapter is one nobody finds when they
   * need to change it.
   *
   * @throws If `name` is already taken. That failure is deliberately not absorbed as success — the
   *   existing secret belongs to some other credential, and adopting it would hand two seats the
   *   same material, which is the shared-login failure this whole feature exists to end. A
   *   registration retrying over its own earlier attempt raises the same error, and wants an
   *   operator looking at it rather than a silent merge.
   * @throws If `value` is empty, for the reason given on {@link SecretReader.write}.
   */
  readonly create: (name: string, value: string) => Promise<string>
  /**
   * Put new material into an existing secret, as a new version.
   *
   * Secrets Manager versions rather than overwrites, so the previous value stays recoverable for as
   * long as it is retained — which is what makes a bad rotation something to roll back instead of an
   * outage. No version id is returned, because nothing in this system orders writes by one: the
   * fence is the integer on the credential row (R9), and offering a second ordering to compare
   * against would invite some later caller to trust the wrong one.
   *
   * @throws If `secretId` does not resolve. Creating it on demand would be worse than failing: the
   *   rotated material would land in a secret nothing references, every holder would keep reading
   *   the value that was supposed to have been replaced, and the rotation would report success.
   * @throws If `value` is empty. An empty credential is not a credential, and storing one moves the
   *   failure from the login that produced it — where an operator can still see what happened — to
   *   a tick minutes or hours later that can only report that the board said no.
   */
  readonly write: (secretId: string, value: string) => Promise<void>
}

/**
 * The subset of `SecretsManagerClient` this adapter uses. Overloads rather than
 * `Pick<SecretsManagerClient, 'send'>` for the same reason as
 * {@link import('./compute').Ec2CommandSender}: a stub must be writable by hand.
 */
export interface SecretsCommandSender {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>
  send(command: CreateSecretCommand): Promise<CreateSecretCommandOutput>
  send(command: PutSecretValueCommand): Promise<PutSecretValueCommandOutput>
}

/**
 * Both write paths refuse blank material before it reaches AWS, so the seam cannot store something
 * `read` is already documented to reject. Failing here costs one round trip; failing at read time
 * costs a tick, and reports the wrong culprit.
 */
const assertMaterial = (value: string, subject: string): void => {
  if (value === '') {
    throw new Error(
      `Refusing to store an empty value in ${subject}. A blank credential authenticates as nobody, and the failure would surface as a board-side authorisation error on some later tick instead of here.`,
    )
  }
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

    create: async (name, value) => {
      assertMaterial(value, `secret ${name}`)

      const output = await client.send(new CreateSecretCommand({ Name: name, SecretString: value }))
      const arn = output.ARN

      if (arn === undefined || arn === '') {
        throw new Error(
          `Secrets Manager created ${name} but returned no ARN. The material now exists with no identifier to record against it, which is not something to paper over: the credential row would point at nothing while a real secret holds a real login.`,
        )
      }

      return arn
    },

    write: async (secretId, value) => {
      assertMaterial(value, `secret ${secretId}`)

      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }))
    },
  }
}
