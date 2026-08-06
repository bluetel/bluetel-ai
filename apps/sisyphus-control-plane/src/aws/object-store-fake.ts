import type { ObjectStore, StoredObject } from './object-store'

/**
 * Recording fake for {@link ObjectStore}, backed by an in-memory key space.
 *
 * It answers `head` and `list` from the same map `put` writes to, so a teardown test can express
 * "the executor persisted three segments and no artifact" as data rather than as a pile of stubbed
 * return values — and the durability check under test then either passes or fails for the reason
 * the test is about.
 *
 * `put` is on the fake and **not** on {@link ObjectStore}: it is how a test states what the
 * executor already wrote, not an operation the control plane is allowed to perform.
 */

export interface FakeObjectStore extends ObjectStore {
  /** Record that an object exists, as though the executor had written it. */
  readonly put: (input: {
    readonly bucket: string
    readonly key: string
    readonly sizeBytes?: number
    readonly lastModified?: Date
  }) => void
  /** Keys passed to `remove`, in order. */
  readonly removals: readonly string[]
  /** Every key currently present, sorted, across all buckets — for a coarse assertion. */
  readonly keys: () => readonly string[]
}

const bucketKey = (bucket: string, key: string): string => `${bucket}/${key}`

export const createFakeObjectStore = (): FakeObjectStore => {
  const objects = new Map<string, StoredObject & { readonly bucket: string }>()
  const removals: string[] = []

  return {
    removals,

    put: (input) => {
      objects.set(bucketKey(input.bucket, input.key), {
        bucket: input.bucket,
        key: input.key,
        sizeBytes: input.sizeBytes ?? 1,
        lastModified: input.lastModified ?? new Date(0),
      })
    },

    keys: () => [...objects.values()].map((object) => object.key).sort(),

    head: (input) => {
      const found = objects.get(bucketKey(input.bucket, input.key))
      return Promise.resolve(
        found === undefined
          ? undefined
          : { key: found.key, sizeBytes: found.sizeBytes, lastModified: found.lastModified },
      )
    },

    list: (input) => {
      const matches = [...objects.values()]
        .filter((object) => object.bucket === input.bucket && object.key.startsWith(input.prefix))
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ key, sizeBytes, lastModified }) => ({ key, sizeBytes, lastModified }))

      return Promise.resolve(input.limit === undefined ? matches : matches.slice(0, input.limit))
    },

    remove: (input) => {
      removals.push(input.key)
      objects.delete(bucketKey(input.bucket, input.key))
      return Promise.resolve()
    },
  }
}
