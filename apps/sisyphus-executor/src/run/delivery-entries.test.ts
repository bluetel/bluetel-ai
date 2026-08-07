import { describe, expect, it } from 'vitest'

import type { CheckedOutEntry, WorkspaceEntry } from '../bootstrap'
import type { Forge, GitCommand, GitCommandResult, GitRunner, PullRequestRef } from '../delivery'
import type { DevelopmentProposal, DevelopmentRequest } from '../workflows'

import {
  prepareDeliveryEntries,
  refusingForge,
  undeliverableEntryError,
  unknownEntryRepositoryError,
  unobservedDeliveryEntryError,
  WORKING_TREE_STATUS,
} from './delivery-entries'

/**
 * The delivery entry list (T230, FR-109, FR-115, FR-118).
 *
 * No socket and no git process. The two seams the delivery path is already built on — a
 * `GitRunner` and the `Forge` port — are the honest place to stand a fake, because what this
 * module adds is *when* each question is asked, not how either is answered.
 */

const API = 'https://forge.test/acme/api'
const WEB = 'https://forge.test/acme/web'
const CHECKOUT_SHA = '1111111111111111111111111111111111111111'
const AGENT_COMMIT = '2222222222222222222222222222222222222222'
const PREVIOUS_PUSH = '3333333333333333333333333333333333333333'
const BRANCH = 'sisyphus/ACME-142-retry-schedule'

const declared = (overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  entryId: 'entry-api',
  repositoryUrl: API,
  baseBranch: 'develop',
  subdirectory: 'api',
  isPrimary: true,
  ...overrides,
})

const checkedOut = (overrides: Partial<CheckedOutEntry> = {}): CheckedOutEntry => ({
  entryId: 'entry-api',
  subdirectory: 'api',
  path: '/workspace/api',
  baseBranch: 'develop',
  resolvedCommit: CHECKOUT_SHA,
  isPrimary: true,
  ...overrides,
})

/** One repository as the fake runner sees it. */
interface RepositoryState {
  /** Porcelain output. Empty means a clean tree. */
  readonly status?: string
  /** git refused to report the tree, with this on stderr. */
  readonly statusFails?: string
  readonly head?: string
  readonly headFails?: boolean
}

interface FakeRunner {
  readonly run: GitRunner
  readonly commands: GitCommand[]
}

const fakeRunner = (states: Readonly<Record<string, RepositoryState | undefined>>): FakeRunner => {
  const commands: GitCommand[] = []

  const run: GitRunner = (command) => {
    commands.push(command)

    const state = states[command.cwd]

    if (state === undefined) {
      return Promise.reject(new Error(`no fake repository at ${command.cwd}`))
    }

    if (command.args[0] === 'status') {
      const result: GitCommandResult =
        state.statusFails === undefined
          ? { stdout: state.status ?? '', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: state.statusFails, exitCode: 128 }

      return Promise.resolve(result)
    }

    if (command.args[0] === 'rev-parse') {
      return Promise.resolve(
        state.headFails === true
          ? { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
          : { stdout: `${state.head ?? CHECKOUT_SHA}\n`, stderr: '', exitCode: 0 },
      )
    }

    return Promise.reject(new Error(`unexpected git ${command.args.join(' ')}`))
  }

  return { run, commands }
}

interface FakeForge {
  readonly forge: Forge
  readonly asked: { readonly repository: string; readonly branch: string }[]
}

interface FakeForgeOptions {
  /** What the host has at the work branch, per repository. Absent means no such branch. */
  readonly heads?: Readonly<Record<string, string>>
  /** Repositories whose `branchHead` throws — anything that is not a 404. */
  readonly fails?: Readonly<Record<string, Error>>
}

const fakeForge = (options: FakeForgeOptions = {}): FakeForge => {
  const asked: { readonly repository: string; readonly branch: string }[] = []

  return {
    asked,
    forge: {
      branchHead: (input) => {
        asked.push({ repository: input.repository, branch: input.branch })

        const failure = options.fails?.[input.repository]

        return failure === undefined
          ? Promise.resolve(options.heads?.[input.repository])
          : Promise.reject(failure)
      },
      findPullRequest: () => Promise.resolve(undefined),
      createPullRequest: () =>
        Promise.resolve<PullRequestRef>({
          number: 1,
          url: 'https://forge.test/pr/1',
          isDraft: true,
        }),
    },
  }
}

const proposal: DevelopmentProposal = {
  conventions: { remote: 'origin', branchName: BRANCH, baseBranch: 'develop' },
  summary: { entries: [], decisions: [], assumptions: [], notDone: [], uncertainties: [] },
}

const request: DevelopmentRequest = {
  ordinal: 1,
  skill: {
    skillName: 'sisyphus-dev',
    entryId: 'entry-api',
    resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
    absolutePath: '/workspace/api/.claude/skills/sisyphus-dev/SKILL.md',
    contentDigest: 'a'.repeat(64),
    byteSize: 19,
    body: 'branch from develop',
  },
  feedback: [],
}

describe('prepareDeliveryEntries — the mapping', () => {
  it('takes each entry’s own base branch, never the primary’s (FR-109)', async () => {
    const { run } = fakeRunner({ '/workspace/api': {}, '/workspace/web': {} })

    const prepared = await prepareDeliveryEntries({
      checkouts: [
        checkedOut(),
        checkedOut({
          entryId: 'entry-web',
          subdirectory: 'web',
          path: '/workspace/web',
          baseBranch: 'main',
          isPrimary: false,
        }),
      ],
      repositories: [
        declared(),
        declared({
          entryId: 'entry-web',
          repositoryUrl: WEB,
          baseBranch: 'main',
          subdirectory: 'web',
          isPrimary: false,
        }),
      ],
      forge: fakeForge().forge,
      run,
    })

    expect(prepared.entries.map((entry) => entry.baseBranch)).toEqual(['develop', 'main'])
    expect(prepared.entries.map((entry) => entry.repository)).toEqual([API, WEB])
    expect(prepared.entries.map((entry) => entry.entryId)).toEqual(['entry-api', 'entry-web'])
  })

  it('gives each entry a reader rooted at its own checkout', async () => {
    const { run, commands } = fakeRunner({ '/workspace/api': {}, '/workspace/web': {} })

    const prepared = await prepareDeliveryEntries({
      checkouts: [
        checkedOut(),
        checkedOut({ entryId: 'entry-web', path: '/workspace/web', isPrimary: false }),
      ],
      repositories: [
        declared(),
        declared({ entryId: 'entry-web', repositoryUrl: WEB, isPrimary: false }),
      ],
      forge: fakeForge().forge,
      run,
    })

    await prepared.entries[0].git.headSha()
    await prepared.entries[1].git.headSha()

    expect(commands.map((command) => command.cwd)).toEqual(['/workspace/api', '/workspace/web'])
  })

  it('refuses a checkout the envelope declares no repository for', async () => {
    const { run } = fakeRunner({ '/workspace/api': {} })

    await expect(
      prepareDeliveryEntries({
        checkouts: [checkedOut({ entryId: 'entry-ghost' })],
        repositories: [declared()],
        forge: fakeForge().forge,
        run,
      }),
    ).rejects.toThrow(unknownEntryRepositoryError('entry-ghost').message)
  })

  it('asks git nothing that could change a repository', async () => {
    const { run, commands } = fakeRunner({ '/workspace/api': { status: ' M src/a.ts\n' } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    await prepared.observe()

    // The runner is wrapped in the delivery path's own guard, so a mutating subcommand could not
    // reach the fake at all. What is asserted here is that none was even attempted.
    expect(commands.map((command) => command.args[0])).toEqual(['status'])
  })
})

describe('prepareDeliveryEntries — the pre-execution probe', () => {
  it('asks the forge for the work branch before the agent runs', async () => {
    const { run } = fakeRunner({ '/workspace/api': {} })
    const forge = fakeForge({ heads: { [API]: PREVIOUS_PUSH } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: forge.forge,
      workBranch: BRANCH,
      run,
    })

    expect(forge.asked).toEqual([{ repository: API, branch: BRANCH }])
    expect(prepared.entries[0].preExecutionRemoteSha).toBe(PREVIOUS_PUSH)
    expect(prepared.probes[0].outcome).toBe('probed')
  })

  it('records no sha when the host has no such branch — the ordinary case for new work', async () => {
    const { run } = fakeRunner({ '/workspace/api': {} })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      workBranch: BRANCH,
      run,
    })

    expect(prepared.entries[0].preExecutionRemoteSha).toBeUndefined()
    expect(prepared.probes[0]).toEqual({
      entryId: 'entry-api',
      repository: API,
      outcome: 'probed',
    })
  })

  it('does not ask at all when the run does not yet know the work branch', async () => {
    const { run } = fakeRunner({ '/workspace/api': {} })
    const forge = fakeForge({ heads: { [API]: PREVIOUS_PUSH } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: forge.forge,
      run,
    })

    // A value read after the pass would be the sha the agent just pushed, and `noPushedWorkError`
    // would discard the work. Asking early or not at all is the whole rule.
    expect(forge.asked).toEqual([])
    expect(prepared.probes[0].outcome).toBe('skipped')
    expect(prepared.entries[0].preExecutionRemoteSha).toBeUndefined()
  })

  it('never flattens a failed probe into “the host had no such branch”', async () => {
    const { run } = fakeRunner({ '/workspace/api': { status: ' M src/a.ts\n' } })
    const forge = fakeForge({ fails: { [API]: new Error('503 from the forge') } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: forge.forge,
      workBranch: BRANCH,
      run,
    })

    expect(prepared.probes[0]).toMatchObject({ outcome: 'failed', reason: '503 from the forge' })
    expect(prepared.entries[0].preExecutionRemoteSha).toBeUndefined()

    await expect(
      prepared.entries[0].forge.branchHead({ repository: API, branch: BRANCH }),
    ).rejects.toThrow(undeliverableEntryError(API, '503 from the forge').message)
  })

  it('leaves the other entries of the workspace deliverable (FR-118)', async () => {
    const { run } = fakeRunner({ '/workspace/api': {}, '/workspace/web': {} })
    const forge = fakeForge({
      heads: { [WEB]: PREVIOUS_PUSH },
      fails: { [API]: new Error('503 from the forge') },
    })

    const prepared = await prepareDeliveryEntries({
      checkouts: [
        checkedOut(),
        checkedOut({ entryId: 'entry-web', path: '/workspace/web', isPrimary: false }),
      ],
      repositories: [
        declared(),
        declared({ entryId: 'entry-web', repositoryUrl: WEB, isPrimary: false }),
      ],
      forge: forge.forge,
      workBranch: BRANCH,
      run,
    })

    expect(prepared.probes.map((probe) => probe.outcome)).toEqual(['failed', 'probed'])
    expect(prepared.entries[1].forge).toBe(forge.forge)
    expect(prepared.entries[1].preExecutionRemoteSha).toBe(PREVIOUS_PUSH)
  })
})

describe('refusingForge', () => {
  it('answers every question with the reason the entry cannot be delivered', async () => {
    const forge = refusingForge(API, '503 from the forge')
    const message = undeliverableEntryError(API, '503 from the forge').message

    await expect(forge.branchHead({ repository: API, branch: BRANCH })).rejects.toThrow(message)
    await expect(
      forge.findPullRequest({ repository: API, head: BRANCH, base: 'develop' }),
    ).rejects.toThrow(message)
    await expect(
      forge.createPullRequest({
        repository: API,
        head: BRANCH,
        base: 'develop',
        title: 'ACME-142',
        body: '',
        draft: true,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(message)
  })
})

describe('prepareDeliveryEntries — what wasChanged counts', () => {
  const observeOne = async (state: RepositoryState): Promise<boolean> => {
    const { run } = fakeRunner({ '/workspace/api': state })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    await prepared.observe()

    return prepared.entries[0].wasChanged
  }

  it('counts an unstaged edit', async () => {
    await expect(observeOne({ status: ' M src/retry.ts\n' })).resolves.toBe(true)
  })

  it('counts a staged edit', async () => {
    await expect(observeOne({ status: 'M  src/retry.ts\n' })).resolves.toBe(true)
  })

  it('counts an untracked file the agent never added', async () => {
    await expect(observeOne({ status: '?? src/retry-schedule.ts\n' })).resolves.toBe(true)
  })

  it('counts a deletion', async () => {
    await expect(observeOne({ status: ' D src/old.ts\n' })).resolves.toBe(true)
  })

  it('counts a commit the agent made itself, even with a clean tree afterwards', async () => {
    await expect(observeOne({ status: '', head: AGENT_COMMIT })).resolves.toBe(true)
  })

  it('is false only for a clean tree still on the checkout commit', async () => {
    await expect(observeOne({ status: '', head: CHECKOUT_SHA })).resolves.toBe(false)
  })

  it('reports a repository git refuses to describe as changed, not as clean', async () => {
    await expect(observeOne({ statusFails: 'fatal: not a git repository' })).resolves.toBe(true)
  })

  it('says which evidence it acted on', async () => {
    const { run } = fakeRunner({
      '/workspace/api': { status: '', head: AGENT_COMMIT },
      '/workspace/web': { statusFails: 'fatal: bad object', headFails: true },
    })

    const prepared = await prepareDeliveryEntries({
      checkouts: [
        checkedOut(),
        checkedOut({ entryId: 'entry-web', path: '/workspace/web', isPrimary: false }),
      ],
      repositories: [
        declared(),
        declared({ entryId: 'entry-web', repositoryUrl: WEB, isPrimary: false }),
      ],
      forge: fakeForge().forge,
      run,
    })

    const observations = await prepared.observe()

    expect(observations[0]).toEqual({
      entryId: 'entry-api',
      repository: API,
      wasChanged: true,
      evidence: 'committed',
    })
    expect(observations[1]).toMatchObject({
      wasChanged: true,
      evidence: 'unreadable',
      detail: 'fatal: bad object',
    })
  })

  it('asks the tree with untracked files included', async () => {
    const { run, commands } = fakeRunner({ '/workspace/api': {} })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    await prepared.observe()

    expect(commands[0].args).toEqual([...WORKING_TREE_STATUS])
  })
})

describe('prepareDeliveryEntries — the ordering', () => {
  it('throws rather than answering false before the tree has been observed', async () => {
    const { run } = fakeRunner({ '/workspace/api': { status: ' M src/retry.ts\n' } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    expect(() => prepared.entries[0].wasChanged).toThrow(
      unobservedDeliveryEntryError('entry-api').message,
    )
  })

  it('observes when the development pass returns, through the wrapped developer port', async () => {
    const { run } = fakeRunner({ '/workspace/api': { status: ' M src/retry.ts\n' } })
    const order: string[] = []

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    const developer = prepared.observing(() => {
      order.push('developed')
      expect(() => prepared.entries[0].wasChanged).toThrow()

      return Promise.resolve(proposal)
    })

    const answer = await developer(request)

    order.push('delivered')

    expect(answer).toBe(proposal)
    expect(order).toEqual(['developed', 'delivered'])
    expect(prepared.entries[0].wasChanged).toBe(true)
  })

  it('does not observe when the pass itself failed', async () => {
    const { run, commands } = fakeRunner({ '/workspace/api': {} })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    const developer = prepared.observing(() => Promise.reject(new Error('no proposal block')))

    await expect(developer(request)).rejects.toThrow('no proposal block')
    expect(commands).toEqual([])
  })

  it('takes the repository’s word and not the agent’s', async () => {
    const { run } = fakeRunner({ '/workspace/api': { status: ' M src/retry.ts\n' } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    // The agent says it changed nothing; the working tree says otherwise. `false` here would open
    // no pull request at all (FR-115), so the observation wins.
    const developer = prepared.observing(() => Promise.resolve({ ...proposal, wasChanged: false }))

    await developer(request)

    expect(prepared.entries[0].wasChanged).toBe(true)
  })

  it('observes once however often it is asked', async () => {
    const { run, commands } = fakeRunner({ '/workspace/api': { status: ' M src/retry.ts\n' } })

    const prepared = await prepareDeliveryEntries({
      checkouts: [checkedOut()],
      repositories: [declared()],
      forge: fakeForge().forge,
      run,
    })

    const developer = prepared.observing(() => Promise.resolve(proposal))

    await developer(request)
    await prepared.observe()
    await prepared.observe()

    expect(commands.filter((command) => command.args[0] === 'status')).toHaveLength(1)
  })
})
