import type { SecretReader } from './secrets'

/**
 * Recording fake for {@link SecretReader}.
 *
 * It records every id it was asked for, because "was the credential read on this tick rather than
 * carried over from the last one" (FR-072) is a question about the sequence of reads, not about the
 * value returned. An unknown id refuses, in the same way the real reader refuses a secret that is
 * not there: a fake that answered every id would make a test pass against an ARN nobody stored.
 */

export interface FakeSecretReader extends SecretReader {
  /** Ids passed to `read`, in order, including repeats. */
  readonly reads: readonly string[]
}

export const createFakeSecretReader = (
  secrets: Readonly<Record<string, string | undefined>> = {},
): FakeSecretReader => {
  const reads: string[] = []

  return {
    reads,

    read: (secretId) => {
      reads.push(secretId)
      const value = secrets[secretId]

      return value === undefined
        ? Promise.reject(new Error(`No fake secret is stored for ${secretId}`))
        : Promise.resolve(value)
    },
  }
}
