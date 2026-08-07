import { afterEach, describe, expect, it } from 'vitest'

import type { TestRepository } from './test-repository'
import { createTestRepository } from './test-repository'

let repository: TestRepository | undefined

afterEach(async () => {
  await repository?.cleanup()
  repository = undefined
})

describe('createTestRepository', () => {
  it('builds a remote and a clone that share a first commit', async () => {
    repository = await createTestRepository()

    const cloneHead = await repository.git(repository.clonePath, 'rev-parse', 'HEAD')
    const remoteHead = await repository.git(repository.remotePath, 'rev-parse', 'main')

    expect(cloneHead).toMatch(/^[0-9a-f]{40}$/)
    expect(cloneHead).toBe(remoteHead)
  })

  it('commits in the clone without touching the remote', async () => {
    repository = await createTestRepository()

    const before = await repository.git(repository.remotePath, 'rev-parse', 'main')
    const local = await repository.commit('local work', 'a.txt', 'a\n')

    expect(await repository.git(repository.remotePath, 'rev-parse', 'main')).toBe(before)
    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD')).toBe(local)
  })

  it('advances the remote independently, which is what staleness looks like', async () => {
    repository = await createTestRepository()

    const before = await repository.git(repository.remotePath, 'rev-parse', 'main')
    const advanced = await repository.commitOnRemote('someone else', 'b.txt', 'b\n')

    expect(advanced).not.toBe(before)
    expect(await repository.git(repository.remotePath, 'rev-parse', 'main')).toBe(advanced)
  })

  it('honours a non-default branch name, since none of this may be hardcoded', async () => {
    repository = await createTestRepository({ defaultBranch: 'trunk' })

    expect(await repository.git(repository.remotePath, 'rev-parse', 'trunk')).toMatch(
      /^[0-9a-f]{40}$/,
    )
  })
})
