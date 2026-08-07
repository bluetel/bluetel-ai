import { describe, expect, it } from 'vitest'

import type { ReviewerSummary } from '../report'
import { buildReviewerSummary } from '../report'

import type { DeliveryConventions } from './conventions'
import { createExternalActionLedger, pendingExternalActions } from './external-action'
import type { CreatePullRequestInput, Forge, PullRequestRef } from './forge'
import type { GitReader } from './git'
import type { PullRequestDelivery } from './pull-request'
import type { PullRequestSetEntry } from './pull-request-set'
import { crossReference, openPullRequestSet } from './pull-request-set'

/**
 * A set of pull requests over one branch (FR-115, FR-116, FR-118).
 *
 * No network and no git process: the two ports are the seams the single-entry
 * path is already built on, so a fake of each is the honest way to exercise the
 * thing this module adds — which is the composition, not the verification.
 */

const WORKFLOW_ID = '3f7b6d2a-1c5e-4a9b-8d3f-2e6c9a4b1d70'
const BRANCH = 'sisyphus/ACME-142-retry-schedule'

const conventions: DeliveryConventions = {
  remote: 'origin',
  branchName: BRANCH,
  baseBranch: 'develop',
  pullRequestTitle: 'ACME-142 Add a retry schedule to reporting',
}

const summary = (): ReviewerSummary =>
  buildReviewerSummary({
    entries: [
      {
        repository: 'https://forge.test/acme/api',
        changed: true,
        description: 'Added the retry schedule.',
      },
    ],
    decisions: ['Reused the existing rate limiter.'],
    assumptions: [],
    notDone: [],
    uncertainties: [],
  })

const unreachable = (what: string) => (): never => {
  throw new Error(`the set asked for ${what}, which this path must not need`)
}

/** A git reader that knows only what the local repository is on. */
const fakeGit = (head: string): GitReader => ({
  headSha: () => Promise.resolve(head),
  resolveSha: () => Promise.resolve(undefined),
  remoteSha: () => Promise.resolve(undefined),
  fetchRef: () => Promise.resolve(),
  countCommitsBetween: () => Promise.resolve(undefined),
})

interface FakeForge {
  readonly forge: Forge
  readonly created: CreatePullRequestInput[]
}

interface FakeForgeOptions {
  /** What the host has at the shared branch. `undefined` means no such branch. */
  readonly head: string | undefined
  readonly repository: string
  /** Thrown by `createPullRequest`, to make one entry of the set fail. */
  readonly createFails?: Error
  readonly existing?: PullRequestRef
}

const fakeForge = (options: FakeForgeOptions): FakeForge => {
  const created: CreatePullRequestInput[] = []
  let nextNumber = 100

  return {
    created,
    forge: {
      branchHead: () => Promise.resolve(options.head),
      findPullRequest: () => Promise.resolve(options.existing),
      createPullRequest: (input) => {
        if (options.createFails !== undefined) {
          return Promise.reject(options.createFails)
        }

        created.push(input)
        nextNumber += 1

        return Promise.resolve({
          number: nextNumber,
          url: `${options.repository}/pull/${String(nextNumber)}`,
          isDraft: input.draft,
        })
      },
    },
  }
}

const API = 'https://forge.test/acme/api'
const WEB = 'https://forge.test/acme/web'
const SHARED = 'https://forge.test/acme/shared'

const entry = (
  repository: string,
  forge: Forge,
  overrides: Partial<PullRequestSetEntry> = {},
): PullRequestSetEntry => ({
  entryId: repository.split('/').pop() ?? repository,
  repository,
  baseBranch: 'develop',
  wasChanged: true,
  git: fakeGit('a'.repeat(40)),
  forge,
  ...overrides,
})

const order = { entryIds: ['shared', 'api', 'web'] }

describe('openPullRequestSet', () => {
  it('opens one pull request per entry, all on one branch (FR-115, FR-116)', async () => {
    const head = 'a'.repeat(40)
    const forges = {
      api: fakeForge({ head, repository: API }),
      web: fakeForge({ head, repository: WEB }),
      shared: fakeForge({ head, repository: SHARED }),
    }

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [
        entry(API, forges.api.forge),
        entry(WEB, forges.web.forge),
        entry(SHARED, forges.shared.forge),
      ],
      promotionOrder: order,
      summary: summary(),
    })

    expect(set.branchName).toBe(BRANCH)
    expect(set.members.map(({ outcome }) => outcome)).toEqual(['opened', 'opened', 'opened'])
    expect(set.isPartial).toBe(false)
    // One branch name across three repositories — the handle a reviewer uses to
    // find the rest of the set from any one of them.
    for (const forge of Object.values(forges)) {
      expect(forge.created).toHaveLength(1)
      expect(forge.created[0].head).toBe(BRANCH)
      expect(forge.created[0].draft).toBe(true)
    }
  })

  it('creates them in the skill-declared integration order, not the workspace’s (FR-117)', async () => {
    const head = 'a'.repeat(40)
    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [
        entry(API, fakeForge({ head, repository: API }).forge),
        entry(WEB, fakeForge({ head, repository: WEB }).forge),
        entry(SHARED, fakeForge({ head, repository: SHARED }).forge),
      ],
      promotionOrder: { entryIds: ['web', 'shared', 'api'] },
      summary: summary(),
    })

    expect(set.members.map(({ entryId }) => entryId)).toEqual(['web', 'shared', 'api'])
    expect(set.members.map(({ position }) => position)).toEqual([1, 2, 3])
  })

  it('refuses to attempt a multi-repository set with no declared order (FR-117)', async () => {
    const head = 'a'.repeat(40)

    await expect(
      openPullRequestSet({
        workflowId: WORKFLOW_ID,
        conventions,
        entries: [
          entry(API, fakeForge({ head, repository: API }).forge),
          entry(WEB, fakeForge({ head, repository: WEB }).forge),
        ],
        summary: summary(),
      }),
    ).rejects.toThrow(/states no order for them/)
  })

  it('proposes each entry onto its own base branch, not the primary’s', async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })
    const web = fakeForge({ head, repository: WEB })

    await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [
        entry(API, api.forge, { baseBranch: 'develop' }),
        // A repository that releases from `main` while the primary uses
        // `develop`: taking the primary's base would propose onto a branch
        // this repository never named.
        entry(WEB, web.forge, { baseBranch: 'main' }),
      ],
      promotionOrder: { entryIds: ['api', 'web'] },
      summary: summary(),
    })

    expect(api.created[0].base).toBe('develop')
    expect(web.created[0].base).toBe('main')
  })

  it('cross-references the whole set from every description (FR-116)', async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })
    const web = fakeForge({ head, repository: WEB })
    const shared = fakeForge({ head, repository: SHARED })

    await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge), entry(WEB, web.forge), entry(SHARED, shared.forge)],
      promotionOrder: order,
      summary: summary(),
    })

    for (const forge of [api, web, shared]) {
      const body = forge.created[0].body

      expect(body).toContain(BRANCH)
      expect(body).toContain(API)
      expect(body).toContain(WEB)
      expect(body).toContain(SHARED)
      // The reviewer's summary is still there; the cross-reference precedes it
      // rather than replacing it (FR-153).
      expect(body).toContain('Added the retry schedule.')
    }
  })

  it('keeps the skill’s own preamble above the summary as well', async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })

    await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions: { ...conventions, bodyPreamble: 'Refs ACME-142.' },
      entries: [entry(API, api.forge)],
      summary: summary(),
    })

    expect(api.created[0].body).toContain('Refs ACME-142.')
    expect(api.created[0].body).toContain(BRANCH)
  })

  it('opens nothing for an entry the agent did not change (FR-115)', async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })
    const web = fakeForge({ head, repository: WEB })

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge), entry(WEB, web.forge, { wasChanged: false })],
      promotionOrder: { entryIds: ['api', 'web'] },
      summary: summary(),
    })

    expect(set.members[1]).toMatchObject({ entryId: 'web', outcome: 'unchanged' })
    expect(set.members[1].pullRequest).toBeUndefined()
    expect(web.created).toHaveLength(0)
    // Unchanged is not a failure, and a set of one change is not partial.
    expect(set.isPartial).toBe(false)
    expect(set.failed).toHaveLength(0)
  })
})

describe('when one entry of the set fails (FR-118)', () => {
  const runPartialSet = async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })
    const web = fakeForge({ head, repository: WEB, createFails: new Error('forge refused: 403') })
    const shared = fakeForge({ head, repository: SHARED })

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge), entry(WEB, web.forge), entry(SHARED, shared.forge)],
      promotionOrder: order,
      summary: summary(),
    })

    return { set, api, web, shared }
  }

  it('records the failure against that entry and still attempts the rest', async () => {
    const { set, api, shared } = await runPartialSet()

    expect(set.members.map(({ entryId, outcome }) => [entryId, outcome])).toEqual([
      ['shared', 'opened'],
      ['api', 'opened'],
      ['web', 'failed'],
    ])
    // `web` is last in the declared order here, so this also proves the earlier
    // two were not unmade — there is nothing to roll a pull request back to.
    expect(api.created).toHaveLength(1)
    expect(shared.created).toHaveLength(1)
  })

  it('says why, in the failing step’s own words', async () => {
    const { set } = await runPartialSet()

    expect(set.failed).toHaveLength(1)
    expect(set.failed[0].reason).toContain('forge refused: 403')
  })

  it('reports the result as partial, which the caller may not call success', async () => {
    const { set } = await runPartialSet()

    expect(set.isPartial).toBe(true)
  })

  it('attempts the entries after the failing one rather than stopping', async () => {
    const head = 'a'.repeat(40)
    const web = fakeForge({ head, repository: WEB, createFails: new Error('forge refused: 403') })
    const api = fakeForge({ head, repository: API })

    // `web` first in the declared order: the entries behind a failure must still
    // reach a result, or "not attempted" and "failed" are indistinguishable.
    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(WEB, web.forge), entry(API, api.forge)],
      promotionOrder: { entryIds: ['web', 'api'] },
      summary: summary(),
    })

    expect(set.members.map(({ outcome }) => outcome)).toEqual(['failed', 'opened'])
    expect(api.created).toHaveLength(1)
  })

  it('is a failure rather than a partial result when nothing was opened', async () => {
    const head = 'a'.repeat(40)
    const refused = new Error('forge refused: 403')

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [
        entry(API, fakeForge({ head, repository: API, createFails: refused }).forge),
        entry(WEB, fakeForge({ head, repository: WEB, createFails: refused }).forge),
      ],
      promotionOrder: { entryIds: ['api', 'web'] },
      summary: summary(),
    })

    expect(set.failed).toHaveLength(2)
    // A set where everything failed is not a partial result, and the outcome
    // needs different words for it.
    expect(set.isPartial).toBe(false)
  })

  it('records an unverified push as that entry’s failure, opening nothing', async () => {
    const api = fakeForge({ head: undefined, repository: API })

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge)],
      summary: summary(),
    })

    expect(set.members[0]).toMatchObject({ outcome: 'failed' })
    expect(set.members[0].reason).toContain('never pushed')
    expect(api.created).toHaveLength(0)
  })

  it('refuses an entry whose base branch is the shared work branch', async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge, { baseBranch: BRANCH })],
      summary: summary(),
    })

    expect(set.members[0].reason).toContain('onto itself')
    expect(api.created).toHaveLength(0)
  })
})

describe('retrying a set that partly succeeded (FR-076, FR-077)', () => {
  it('replays what it already opened instead of opening it twice', async () => {
    const head = 'a'.repeat(40)
    const api = fakeForge({ head, repository: API })
    const ledger = createExternalActionLedger<PullRequestDelivery>()
    const input = {
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge)],
      summary: summary(),
      ledger,
    }

    const first = await openPullRequestSet(input)
    const second = await openPullRequestSet(input)

    expect(api.created).toHaveLength(1)
    expect(second.members[0].pullRequest?.number).toBe(first.members[0].pullRequest?.number)
    expect(second.members[0].alreadyExisted).toBe(true)
  })

  it('leaves a failed entry pending on the ledger, so a halt can name it (FR-076)', async () => {
    const head = 'a'.repeat(40)
    const ledger = createExternalActionLedger<PullRequestDelivery>()

    await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [
        entry(WEB, fakeForge({ head, repository: WEB, createFails: new Error('403') }).forge),
      ],
      summary: summary(),
      ledger,
    })

    expect(pendingExternalActions(ledger)).toHaveLength(1)
    expect(pendingExternalActions(ledger)[0].key).toContain(WEB)
  })

  it('returns a pull request the forge already had without creating a second', async () => {
    const head = 'a'.repeat(40)
    const existing = { number: 7, url: `${API}/pull/7`, isDraft: true }
    const api = fakeForge({ head, repository: API, existing })

    const set = await openPullRequestSet({
      workflowId: WORKFLOW_ID,
      conventions,
      entries: [entry(API, api.forge)],
      summary: summary(),
    })

    expect(set.members[0]).toMatchObject({ outcome: 'opened', alreadyExisted: true })
    expect(set.members[0].pullRequest).toEqual(existing)
    expect(api.created).toHaveLength(0)
  })
})

describe('crossReference', () => {
  it('names the branch and every repository, in order', () => {
    const text = crossReference(BRANCH, [
      {
        entry: entry(SHARED, fakeForge({ head: undefined, repository: SHARED }).forge),
        position: 1,
      },
      { entry: entry(API, fakeForge({ head: undefined, repository: API }).forge), position: 2 },
    ])

    expect(text).toContain(BRANCH)
    expect(text.indexOf(SHARED)).toBeLessThan(text.indexOf(API))
    expect(text).toContain('1. ')
    expect(text).toContain('2. ')
  })

  it('is identical whichever member carries it, because it names no member', () => {
    const members = [
      { entry: entry(API, fakeForge({ head: undefined, repository: API }).forge), position: 1 },
      { entry: entry(WEB, fakeForge({ head: undefined, repository: WEB }).forge), position: 2 },
    ]

    // The same text on both, which is what makes the set findable from either.
    expect(crossReference(BRANCH, members)).toBe(crossReference(BRANCH, members))
    expect(crossReference(BRANCH, members)).not.toContain('this one')
  })

  it('needs no forge and no network to compose', () => {
    const text = crossReference(BRANCH, [
      {
        entry: {
          entryId: 'api',
          repository: API,
          baseBranch: 'develop',
          wasChanged: true,
          git: fakeGit('a'.repeat(40)),
          forge: {
            branchHead: unreachable('a branch head'),
            findPullRequest: unreachable('an existing pull request'),
            createPullRequest: unreachable('a pull request'),
          },
        },
        position: 1,
      },
    ])

    expect(text).toContain(API)
  })
})
