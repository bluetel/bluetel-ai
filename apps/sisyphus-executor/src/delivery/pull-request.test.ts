import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReviewerSummary } from '../report'
import { buildReviewerSummary } from '../report'

import type { DeliveryConventions } from './conventions'
import type { CreatePullRequestInput, Forge } from './forge'
import { createGitReader } from './git'
import { openDraftPullRequest } from './pull-request'
import type { TestRepository } from './test-repository'
import { createTestRepository } from './test-repository'

const WORKFLOW_ID = '3f7b6d2a-1c5e-4a9b-8d3f-2e6c9a4b1d70'

let repository: TestRepository | undefined

afterEach(async () => {
  await repository?.cleanup()
  repository = undefined
})

const conventions: DeliveryConventions = {
  remote: 'origin',
  branchName: 'sisyphus/ACME-142-retry-schedule',
  baseBranch: 'develop',
  pullRequestTitle: 'ACME-142 Add a retry schedule to reporting',
}

const summary = (): ReviewerSummary =>
  buildReviewerSummary({
    entries: [
      {
        repository: 'https://forge.test/acme/web',
        changed: true,
        description: 'Added the retry schedule.',
      },
    ],
    decisions: ['Reused the existing rate limiter.'],
    assumptions: [],
    notDone: ['Left the migration alone.'],
    uncertainties: [],
  })

interface FakeForge {
  readonly forge: Forge
  readonly created: CreatePullRequestInput[]
  /** What the host has at the work branch. `undefined` means no such branch. */
  head: string | undefined
  existing: boolean
}

const fakeForge = (head: string | undefined): FakeForge => {
  const created: CreatePullRequestInput[] = []
  const state = { head, existing: false }
  let nextNumber = 41

  return {
    created,
    get head() {
      return state.head
    },
    set head(value: string | undefined) {
      state.head = value
    },
    get existing() {
      return state.existing
    },
    set existing(value: boolean) {
      state.existing = value
    },
    forge: {
      branchHead: () => Promise.resolve(state.head),
      findPullRequest: () =>
        Promise.resolve(
          state.existing
            ? { number: 7, url: 'https://forge.test/acme/web/pull/7', isDraft: true }
            : undefined,
        ),
      createPullRequest: (input) => {
        created.push(input)
        nextNumber += 1

        return Promise.resolve({
          number: nextNumber,
          url: `https://forge.test/acme/web/pull/${String(nextNumber)}`,
          isDraft: input.draft,
        })
      },
    },
  }
}

describe('openDraftPullRequest', () => {
  it('opens a draft pull request once the commit is verified on the forge', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const localHead = await git.headSha()
    const forge = fakeForge(localHead)

    const delivery = await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      preExecutionRemoteSha: undefined,
      summary: summary(),
      git,
      forge: forge.forge,
    })

    expect(delivery.verifiedSha).toBe(localHead)
    expect(delivery.alreadyExisted).toBe(false)
    expect(delivery.pullRequest.isDraft).toBe(true)
    expect(forge.created).toHaveLength(1)
    expect(forge.created[0].draft).toBe(true)
  })

  it('takes every convention from the skill and hardcodes none of them', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())
    const unusual: DeliveryConventions = {
      remote: 'upstream',
      branchName: 'feature/PROJ-9',
      baseBranch: 'trunk',
      pullRequestTitle: 'PROJ-9 — something entirely bespoke',
      bodyPreamble: 'Refs PROJ-9.',
    }

    await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions: unusual,
      summary: summary(),
      git,
      forge: forge.forge,
    })

    expect(forge.created[0]).toMatchObject({
      head: 'feature/PROJ-9',
      base: 'trunk',
      title: 'PROJ-9 — something entirely bespoke',
    })
    expect(forge.created[0].body.startsWith('Refs PROJ-9.')).toBe(true)
  })

  it('includes the reviewer summary in the description, per FR-153', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())
    const reviewerSummary = summary()

    await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: reviewerSummary,
      git,
      forge: forge.forge,
    })

    expect(forge.created[0].body).toContain(reviewerSummary.markdown)
    expect(forge.created[0].body).toContain('## Deliberately not done')
  })

  it('opens nothing when the branch never reached the forge', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(undefined)

    await expect(
      openDraftPullRequest({
        workflowId: WORKFLOW_ID,
        repository: 'https://forge.test/acme/web',
        conventions,
        summary: summary(),
        git,
        forge: forge.forge,
      }),
    ).rejects.toThrow(/is not on the forge, so the commit .* was never pushed/)

    expect(forge.created).toEqual([])
  })

  it('opens nothing when the forge is behind the commit the run produced', async () => {
    repository = await createTestRepository()
    const firstPush = await repository.commit('first', 'a.txt', 'a\n')
    await repository.commit('second, never pushed', 'b.txt', 'b\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const localHead = await git.headSha()
    const forge = fakeForge(firstPush)

    await expect(
      openDraftPullRequest({
        workflowId: WORKFLOW_ID,
        repository: 'https://forge.test/acme/web',
        conventions,
        summary: summary(),
        git,
        forge: forge.forge,
      }),
    ).rejects.toThrow(
      `The forge has ${conventions.branchName} at ${firstPush.slice(0, 12)} but the run produced ${localHead.slice(0, 12)}`,
    )

    expect(forge.created).toEqual([])
  })

  it('opens nothing when the branch is exactly where it was before the run', async () => {
    repository = await createTestRepository()

    const git = createGitReader({ cwd: repository.clonePath })
    const unchanged = await git.headSha()
    const forge = fakeForge(unchanged)

    await expect(
      openDraftPullRequest({
        workflowId: WORKFLOW_ID,
        repository: 'https://forge.test/acme/web',
        conventions,
        // Recorded before any agent work began.
        preExecutionRemoteSha: unchanged,
        summary: summary(),
        git,
        forge: forge.forge,
      }),
    ).rejects.toThrow(/this run pushed nothing/)

    expect(forge.created).toEqual([])
  })

  it('returns the existing pull request instead of opening a second one', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())

    forge.existing = true

    const delivery = await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: summary(),
      git,
      forge: forge.forge,
    })

    expect(delivery.alreadyExisted).toBe(true)
    expect(delivery.pullRequest.number).toBe(7)
    expect(forge.created).toEqual([])
  })

  it('sends the same idempotency key on a retry of the same delivery', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())
    const input = {
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: summary(),
      git,
      forge: forge.forge,
    }

    await openDraftPullRequest(input)
    await openDraftPullRequest(input)

    expect(forge.created[0].idempotencyKey).toBe(forge.created[1].idempotencyKey)
  })

  it('opens ready for review only when the request explicitly says so', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())
    const base = {
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: summary(),
      git,
      forge: forge.forge,
    }

    await openDraftPullRequest(base)
    await openDraftPullRequest({ ...base, readyForReview: false })
    await openDraftPullRequest({ ...base, readyForReview: true })

    expect(forge.created.map((created) => created.draft)).toEqual([true, true, false])
  })

  it('performs no ticket transition and reaches for nothing that could', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())
    const touched = new Set<string>()
    const watched = new Proxy(forge.forge, {
      get: (target, property, receiver) => {
        touched.add(String(property))

        return Reflect.get(target, property, receiver) as unknown
      },
    })

    const delivery = await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: summary(),
      git,
      forge: watched,
    })

    // FR-060: delivery ownership stays with the initiating engineer.
    expect(delivery.ticketTransitioned).toBe(false)
    // Nothing outside the three read/create methods was even reached for.
    expect([...touched].sort()).toEqual(['branchHead', 'createPullRequest', 'findPullRequest'])
  })

  it('changes nothing in the repository it delivers from', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const forge = fakeForge(await git.headSha())
    const before = await repository.git(repository.clonePath, 'rev-parse', 'HEAD')
    const status = await repository.git(repository.clonePath, 'status', '--porcelain')

    await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: summary(),
      git,
      forge: forge.forge,
    })

    expect(await repository.git(repository.clonePath, 'rev-parse', 'HEAD')).toBe(before)
    expect(await repository.git(repository.clonePath, 'status', '--porcelain')).toBe(status)
  })

  it('asks the forge, not the working copy, whether the push landed', async () => {
    repository = await createTestRepository()
    await repository.commit('the work', 'work.txt', 'work\n')

    const git = createGitReader({ cwd: repository.clonePath })
    const branchHead = vi.fn(async () => git.headSha())

    await openDraftPullRequest({
      workflowId: WORKFLOW_ID,
      repository: 'https://forge.test/acme/web',
      conventions,
      summary: summary(),
      git,
      forge: { ...fakeForge(undefined).forge, branchHead },
    })

    expect(branchHead).toHaveBeenCalledWith({
      repository: 'https://forge.test/acme/web',
      branch: conventions.branchName,
    })
  })
})
