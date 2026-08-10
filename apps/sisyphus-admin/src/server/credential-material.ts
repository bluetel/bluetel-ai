import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import type { AgentCredentialMaterialStore } from '@bluetel-ai/sisyphus-api/server'

/**
 * **The machine surface's secret store, as the panel supplies it** (003/FR-011, FR-012, FR-030,
 * FR-032).
 *
 * `sisyphus-api` declares `AgentCredentialMaterialStore` as a port and defaults it to one that
 * refuses in both directions, because the package must not construct an AWS client. This is the
 * implementation for the host that actually needs one.
 *
 * ## Why the panel, of all three members
 *
 * Because the panel is where the machine surface is mounted. FR-012 says material must not travel
 * in the job envelope and the instance must fetch it with its workflow-scoped credential; that
 * fetch is `machine.fetchAgentCredential`, and `/api/machine` is a route in this application. The
 * control plane never builds a `SisyphusDependencies` at all — it dispatches jobs — so there is no
 * other composition root this port could be filled from. Wired nowhere, the executor's
 * `credential_install` phase reaches the refusing default and **no run can start**, which is the
 * state this application was in until this module existed.
 *
 * ## Why it is a second Secrets Manager adapter and not the control plane's
 *
 * `apps/sisyphus-control-plane/src/aws/secrets.ts` has the same two methods with the same names —
 * deliberately, so that wiring is an assignment rather than an adaptation — and this application
 * cannot import it. Nothing in this repository imports one application from another: apps publish
 * no `exports` map, and reaching into one would drag its EC2, SSM and Scheduler clients plus its
 * validated environment into a Next.js bundle. The precedent for the answer is
 * `lib/bundles/s3-object-store.ts`, which is the panel's own S3 adapter beside the control plane's,
 * for exactly the same reason.
 *
 * The two adapters are narrow and their overlap is small: this one has **no `create`**. Minting a
 * secret is the login capture's act, performed in the control plane where the material already is,
 * and a machine surface able to create one could file material under an identifier nothing
 * references while reporting success. The port does not declare it, so the omission is enforced by
 * the type rather than by restraint.
 *
 * ## Nothing is cached, and that is not an oversight
 *
 * A warm Lambda container serves many requests for hours, and a rotation is written by one process
 * and read by the next boot. A cached read here would hand a fresh instance material the provider
 * has already invalidated — the precise failure the credential pool exists to prevent — and it
 * would surface as an authorisation error somewhere far from the cause. Every read is a fresh
 * `GetSecretValue`; the control plane's adapter documents the same rule from its own side.
 *
 * ## What still has to be true of the deployment
 *
 * The panel's server function needs `secretsmanager:GetSecretValue` and
 * `secretsmanager:PutSecretValue` on the stage's agent-credential secret prefix, and needs neither
 * `CreateSecret` nor `DeleteSecret` nor `ListSecrets`. Until it has them, this adapter fails with
 * an AWS authorisation error naming the secret — which is a far better failure than the refusing
 * default's, because it names something an operator can grant rather than reporting a deployment
 * that "has no store configured" for ever.
 */

/**
 * The part of `SecretsManagerClient` this module uses.
 *
 * Declared as overloads rather than `Pick<SecretsManagerClient, 'send'>` for the reason the control
 * plane's `SecretsCommandSender` is: a test double must be writable by hand, and the real client's
 * `send` signature is a union of every command it has ever supported.
 */
export interface SecretsCommandSender {
  send(command: GetSecretValueCommand): Promise<{ readonly SecretString?: string }>
  send(command: PutSecretValueCommand): Promise<unknown>
}

/**
 * Refuse to store blank material before it reaches AWS.
 *
 * The same guard the control plane's adapter applies, restated here rather than shared because the
 * two adapters share no code. A blank credential authenticates as nobody, and storing one moves the
 * failure from the rotation that produced it — where the fence, the workflow and the instance are
 * all still in view — to some later boot that can only report that the provider said no.
 */
const assertMaterial = (secretId: string, material: string): void => {
  if (material === '') {
    throw new Error(
      `Refusing to store empty material in secret ${secretId}. A blank credential authenticates as nobody, and the failure would surface as a provider authorisation error on some later boot instead of here.`,
    )
  }
}

/**
 * Wrap a sender as the port.
 *
 * The client is injected rather than constructed inside the methods, so a suite can hand in a
 * recording double and assert on the command inputs — which is the only way to state that a read is
 * a `GetSecretValue` against the identifier it was given and nothing more.
 */
export const createSecretsManagerMaterialStore = (options: {
  readonly client: SecretsCommandSender
}): AgentCredentialMaterialStore => ({
  read: async (secretId) => {
    const output = await options.client.send(new GetSecretValueCommand({ SecretId: secretId }))
    const value = output.SecretString

    if (value === undefined || value === '') {
      // Thrown rather than answered as `''`, because the port says so and because the caller turns
      // a throw into an error the executor's FR-047 backoff retries. An empty answer would install
      // a working credential's worth of nothing on a paid instance.
      throw new Error(
        `Secret ${secretId} holds no string value. Agent credential material is stored as a string secret; a binary one cannot be written to the instance's credential file.`,
      )
    }

    return value
  },

  write: async (secretId, material) => {
    assertMaterial(secretId, material)

    await options.client.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: material }),
    )
  },
})

/**
 * The real store.
 *
 * A function rather than a module constant, and the region is a parameter rather than an
 * environment read — the same argument `createBundleObjectStore` and `getAuthDatabase` make.
 * `next build` imports every route module while collecting page data, and a constant here would
 * construct a client at build time for a route nobody is calling. Constructing one opens no
 * connection, so a request that reads no material pays for nothing either way.
 *
 * @param region - `AWS_REGION` from the validated environment, passed by the composition root.
 */
export const createAgentCredentialMaterialStore = (region: string): AgentCredentialMaterialStore =>
  createSecretsManagerMaterialStore({ client: new SecretsManagerClient({ region }) })
