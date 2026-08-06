import type { ParameterStore } from './parameter-store'

/**
 * Recording fake for {@link ParameterStore}.
 *
 * It records `secure` per write, because "the credential was written unencrypted" is exactly the
 * kind of regression FR-037 cares about and a fake that only remembered names could not catch it.
 * Removals are recorded in order so a teardown test can assert that revocation happened *after*
 * durability was confirmed rather than merely that it happened.
 */

export interface FakeParameter {
  readonly value: string
  readonly secure: boolean
}

export interface FakeParameterStore extends ParameterStore {
  /** Names passed to `remove`, in order. */
  readonly removals: readonly string[]
  /** The current contents, for asserting on what was written rather than only that it was. */
  readonly current: (name: string) => FakeParameter | undefined
  /** Every name currently present, sorted. */
  readonly names: () => readonly string[]
}

export const createFakeParameterStore = (): FakeParameterStore => {
  const parameters = new Map<string, FakeParameter>()
  const removals: string[] = []

  return {
    removals,

    current: (name) => parameters.get(name),

    names: () => [...parameters.keys()].sort(),

    write: (input) => {
      parameters.set(input.name, { value: input.value, secure: input.secure !== false })
      return Promise.resolve()
    },

    read: (input) => Promise.resolve(parameters.get(input.name)?.value),

    remove: (input) => {
      removals.push(input.name)
      parameters.delete(input.name)
      return Promise.resolve()
    },
  }
}
