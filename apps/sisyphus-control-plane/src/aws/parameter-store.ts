import type {
  DeleteParameterCommandOutput,
  GetParameterCommandOutput,
  PutParameterCommandOutput,
} from '@aws-sdk/client-ssm'
import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
} from '@aws-sdk/client-ssm'

/**
 * The parameter seam — what the control plane needs from SSM (T054).
 *
 * **What this is not for.** The workflow-scoped credential travels in the user-data envelope, as
 * `contracts/executor-protocol.md` specifies: user data is readable by every process on the
 * instance, but the credential is short-lived, single-workflow and machine-surface-only, so it is
 * not a long-lived secret and putting it there costs nothing that its scope has not already
 * bounded. Revocation stays an action rather than an expiry because the `scoped_credentials` row —
 * not the token's own `exp` — is what `machineProcedure` consults.
 *
 * **What it is for**: deploy-time configuration, per plan.md's Storage section — values written by
 * the deploy and read by a job, and anything that must reach an instance without fitting inside
 * user-data's 16 KB cap.
 *
 * `remove` treats "not there" as success. A job retrying after a partial failure must converge, and
 * a delete that fails because the parameter is already gone reads as a failure while describing the
 * desired state.
 */

export interface ParameterStore {
  /** Write (or overwrite) a parameter. Encrypted at rest unless `secure` is explicitly false. */
  readonly write: (input: {
    readonly name: string
    readonly value: string
    readonly secure?: boolean
  }) => Promise<void>
  /** The value, or `undefined` when the parameter does not exist. */
  readonly read: (input: { readonly name: string }) => Promise<string | undefined>
  /** Delete a parameter. Idempotent: deleting an absent parameter succeeds. */
  readonly remove: (input: { readonly name: string }) => Promise<void>
}

/** The subset of `SSMClient` this adapter uses. */
export interface SsmCommandSender {
  send(command: PutParameterCommand): Promise<PutParameterCommandOutput>
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>
  send(command: DeleteParameterCommand): Promise<DeleteParameterCommandOutput>
}

export const createSsmParameterStore = (options: {
  readonly client: SsmCommandSender
}): ParameterStore => {
  const { client } = options

  return {
    write: async (input) => {
      await client.send(
        new PutParameterCommand({
          Name: input.name,
          Value: input.value,
          Type: input.secure === false ? 'String' : 'SecureString',
          Overwrite: true,
        }),
      )
    },

    read: async (input) => {
      try {
        const output = await client.send(
          new GetParameterCommand({ Name: input.name, WithDecryption: true }),
        )
        return output.Parameter?.Value
      } catch (thrown) {
        if (thrown instanceof ParameterNotFound) {
          return undefined
        }
        throw thrown
      }
    },

    remove: async (input) => {
      try {
        await client.send(new DeleteParameterCommand({ Name: input.name }))
      } catch (thrown) {
        if (thrown instanceof ParameterNotFound) {
          return
        }
        throw thrown
      }
    },
  }
}
