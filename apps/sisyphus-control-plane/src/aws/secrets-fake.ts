import type { SecretReader } from './secrets'

/**
 * Recording fake for {@link SecretReader}, backed by an in-memory key space.
 *
 * It records every id it was asked for, because "was the credential read on this tick rather than
 * carried over from the last one" (FR-072) is a question about the sequence of reads, not about the
 * value returned. `create` and `write` land in the same map `read` answers from, so a rotation test
 * can say "log in, then read" and get the value the login actually stored — rather than a stub
 * return value that would agree with the test no matter what the code under test wrote.
 *
 * **It refuses everything the real seam refuses**, and this is the point rather than a nicety. Every
 * downstream phase asserts against this fake, so a lenient fake is not a weaker test but a wrong
 * one: it would let a duplicate registration pass here and fail in the account, and it would let a
 * rotation write to an id nothing resolves and report success. So a second `create` under a name
 * already taken rejects, a `write` to an unknown id rejects without creating it, and blank material
 * is refused on both paths.
 *
 * Ids are handed out, not chosen: `create` returns an ARN-shaped string that only means anything to
 * this fake. Tests should pass that value back to `read` and `write` and never rebuild it — real
 * Secrets Manager appends six random characters to the name, so any test that reconstructs an
 * identifier is asserting something that is not true of the thing it stands in for.
 */

export interface FakeSecretReader extends SecretReader {
  /** Ids passed to `read`, in order, including repeats. */
  readonly reads: readonly string[]
  /** Every `create` that succeeded, in order, with the id it was given. */
  readonly creations: readonly {
    readonly name: string
    readonly secretId: string
    readonly value: string
  }[]
  /** Every `write` that succeeded, in order — the record a rotation test asserts against. */
  readonly writes: readonly { readonly secretId: string; readonly value: string }[]
  /**
   * The value currently stored under an id, without recording a read.
   *
   * Inspection, not an operation: `reads` is evidence about what the control plane did, and a test
   * checking its own setup must not be able to forge that evidence — the same reason
   * {@link import('./object-store-fake').FakeObjectStore.put} is on the fake and not on the seam.
   */
  readonly stored: (secretId: string) => string | undefined
}

/**
 * ARN-shaped enough to be recognisable in a failure message, and fixed rather than random so a
 * failing test reads the same way twice. The account id is zeroes to make it obvious to anyone
 * reading a log that no account was involved.
 */
const fakeSecretId = (name: string): string =>
  `arn:aws:secretsmanager:eu-west-2:000000000000:secret:${name}`

export const createFakeSecretReader = (
  secrets: Readonly<Record<string, string | undefined>> = {},
): FakeSecretReader => {
  const values = new Map<string, string>(
    Object.entries(secrets).flatMap(([secretId, value]) =>
      value === undefined ? [] : [[secretId, value] as const],
    ),
  )
  const reads: string[] = []
  const creations: { name: string; secretId: string; value: string }[] = []
  const writes: { secretId: string; value: string }[] = []

  const rejectBlank = (subject: string): Promise<never> =>
    Promise.reject(
      new Error(
        `Refusing to store an empty value in ${subject}. A blank credential authenticates as nobody, and the failure would surface as a board-side authorisation error on some later tick instead of here.`,
      ),
    )

  return {
    reads,
    creations,
    writes,

    stored: (secretId) => values.get(secretId),

    read: (secretId) => {
      reads.push(secretId)
      const value = values.get(secretId)

      return value === undefined
        ? Promise.reject(new Error(`No fake secret is stored for ${secretId}`))
        : Promise.resolve(value)
    },

    create: (name, value) => {
      if (value === '') {
        return rejectBlank(`secret ${name}`)
      }

      const secretId = fakeSecretId(name)

      if (values.has(secretId)) {
        return Promise.reject(
          new Error(
            `A fake secret named ${name} already exists. The real seam raises ResourceExistsException here, and adopting the existing secret would give two credentials the same material.`,
          ),
        )
      }

      values.set(secretId, value)
      creations.push({ name, secretId, value })

      return Promise.resolve(secretId)
    },

    write: (secretId, value) => {
      if (value === '') {
        return rejectBlank(`secret ${secretId}`)
      }

      if (!values.has(secretId)) {
        return Promise.reject(
          new Error(
            `No fake secret is stored for ${secretId}, so there is nothing to write to. The real seam raises ResourceNotFoundException rather than creating one, because rotated material in a secret nobody references leaves every holder on the value it was supposed to replace.`,
          ),
        )
      }

      values.set(secretId, value)
      writes.push({ secretId, value })

      return Promise.resolve()
    },
  }
}
