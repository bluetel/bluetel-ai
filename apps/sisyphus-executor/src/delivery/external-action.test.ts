import { describe, expect, it } from 'vitest'

import type { ExternalActionIdentity } from './external-action'
import {
  createExternalActionLedger,
  EXTERNAL_ACTION_KEY_SEPARATOR,
  externalActionKey,
  pendingExternalActions,
  performExternalAction,
  pullRequestIdentity,
} from './external-action'
import { pullRequestIdempotencyKey } from './forge'

/**
 * FR-077, tested as the failure it prevents rather than as an interface.
 *
 * The scenario throughout is the concrete one: a remote accepts a request, the connection dies
 * before the response arrives, the executor cannot tell that from a request that was never seen,
 * and FR-047 has it retry. What must not happen is a second comment on a customer's ticket or a
 * second pull request for one run.
 *
 * Nothing here opens a socket. Both remotes are objects that count their calls, which is the only
 * way to assert "at most once" at all.
 */

/** A ticket remote that accepts comments and can be asked what it holds. */
const createTicketRemote = (): {
  readonly comments: string[]
  readonly post: (body: string) => Promise<string>
  readonly find: () => Promise<string | undefined>
  posts: number
} => {
  const state = {
    comments: [] as string[],
    posts: 0,
    post: (body: string): Promise<string> => {
      state.posts += 1
      state.comments.push(body)
      return Promise.resolve(`comment-${String(state.comments.length)}`)
    },
    find: (): Promise<string | undefined> =>
      Promise.resolve(state.comments.length === 0 ? undefined : 'comment-1'),
  }

  return state
}

const RUN = '01890a5d-ac96-774b-bcce-b302099a8057'

/**
 * Built here rather than imported, because the delivery barrel deliberately exports nothing that
 * names a ticket — FR-060 leaves the ticket with the initiating engineer, and `index.test.ts`
 * holds that to an absence rather than a convention. These are what
 * `packages/sisyphus-integration-jira` will build for itself, in the shape this module's key
 * builder takes.
 */
const ticketCommentIdentity = (input: {
  readonly workflowId: string
  readonly ticket: string
  readonly purpose: string
}): ExternalActionIdentity => ({
  action: 'comment',
  workflowId: input.workflowId,
  target: [input.ticket, input.purpose],
})

const ticketTransitionIdentity = (input: {
  readonly workflowId: string
  readonly ticket: string
  readonly status: string
}): ExternalActionIdentity => ({
  action: 'transition',
  workflowId: input.workflowId,
  target: [input.ticket, input.status],
})

describe('the key', () => {
  it('is byte-for-byte the key the pull-request path already sends', () => {
    // The delivery path in `./pull-request.ts` derives its key with `pullRequestIdempotencyKey`.
    // If these ever differed, adopting this module there would change the key mid-flight and a
    // retry across the change would open a second pull request — which is the failure, not the fix.
    const input = { workflowId: RUN, repository: 'acme/api', head: 'sisyphus/123', base: 'main' }

    expect(externalActionKey(pullRequestIdentity(input))).toBe(pullRequestIdempotencyKey(input))
    expect(externalActionKey(pullRequestIdentity(input))).toBe(
      ['pull-request', RUN, 'acme/api', 'sisyphus/123', 'main'].join(EXTERNAL_ACTION_KEY_SEPARATOR),
    )
  })

  it('is derived, so the same action produces the same key every time', () => {
    const identity = ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose: 'summary' })

    expect(externalActionKey(identity)).toBe(externalActionKey({ ...identity }))
  })

  it('separates two runs, so a second run is never mistaken for a retry of the first', () => {
    const of = (workflowId: string): string =>
      externalActionKey(ticketCommentIdentity({ workflowId, ticket: 'ABC-1', purpose: 'summary' }))

    expect(of(RUN)).not.toBe(of('another-run'))
  })

  it('separates two comments on one ticket, so a run can say more than one thing', () => {
    const of = (purpose: string): string =>
      externalActionKey(ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose }))

    expect(of('summary')).not.toBe(of('halted'))
  })

  it('separates a comment from a transition on the same ticket', () => {
    expect(
      externalActionKey(ticketCommentIdentity({ workflowId: RUN, ticket: 'A-1', purpose: 'x' })),
    ).not.toBe(
      externalActionKey(ticketTransitionIdentity({ workflowId: RUN, ticket: 'A-1', status: 'x' })),
    )
  })
})

describe('performing an action', () => {
  const identity = ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose: 'summary' })

  it('performs it once and replays the result on every later attempt', async () => {
    const remote = createTicketRemote()
    const ledger = createExternalActionLedger<string>()
    const action = {
      identity,
      find: remote.find,
      perform: (): Promise<string> => remote.post('the summary'),
    }

    const first = await performExternalAction(ledger, action)
    const second = await performExternalAction(ledger, action)

    expect(first.disposition).toBe('performed')
    expect(second.disposition).toBe('replayed')
    expect(second.result).toBe(first.result)
    expect(remote.posts).toBe(1)
  })

  it('returns what the remote already holds without performing anything', async () => {
    const remote = createTicketRemote()
    await remote.post('posted by an earlier attempt in an earlier process')

    const ledger = createExternalActionLedger<string>()
    const outcome = await performExternalAction(ledger, {
      identity,
      find: remote.find,
      perform: (): Promise<string> => remote.post('the summary'),
    })

    expect(outcome.disposition).toBe('already-performed')
    expect(remote.posts).toBe(1)
  })

  it('hands the remote the derived key, for remotes that honour one of their own', async () => {
    const ledger = createExternalActionLedger<string>()
    let seen: string | undefined

    await performExternalAction(ledger, {
      identity,
      perform: (idempotencyKey): Promise<string> => {
        seen = idempotencyKey
        return Promise.resolve('ok')
      },
    })

    expect(seen).toBe(externalActionKey(identity))
  })
})

describe('a timeout after the remote accepted the request', () => {
  const identity = ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose: 'summary' })

  /**
   * The whole point of the module, in one test.
   *
   * The remote records the comment and *then* the connection dies, so `perform` throws having
   * succeeded. Without the recheck the executor reports a failure, retries, and the customer ends
   * up with two identical comments on their ticket from an automated system.
   */
  it('recognises that the action landed, and neither throws nor posts a second time', async () => {
    const remote = createTicketRemote()
    const ledger = createExternalActionLedger<string>()

    const outcome = await performExternalAction(ledger, {
      identity,
      find: remote.find,
      perform: async (): Promise<string> => {
        await remote.post('the summary')
        throw new Error('socket hang up')
      },
    })

    expect(outcome.disposition).toBe('already-performed')
    expect(outcome.result).toBe('comment-1')
    expect(remote.comments).toStrictEqual(['the summary'])
    expect(remote.posts).toBe(1)
  })

  it('leaves nothing pending, so a halt does not name an action that in fact landed', async () => {
    const remote = createTicketRemote()
    const ledger = createExternalActionLedger<string>()

    await performExternalAction(ledger, {
      identity,
      find: remote.find,
      perform: async (): Promise<string> => {
        await remote.post('the summary')
        throw new Error('socket hang up')
      },
    })

    expect(pendingExternalActions(ledger)).toStrictEqual([])
  })

  it('still posts nothing extra when the caller retries anyway', async () => {
    const remote = createTicketRemote()
    const ledger = createExternalActionLedger<string>()
    const action = {
      identity,
      find: remote.find,
      perform: async (): Promise<string> => {
        await remote.post('the summary')
        throw new Error('socket hang up')
      },
    }

    await performExternalAction(ledger, action)
    const retry = await performExternalAction(ledger, action)

    expect(retry.disposition).toBe('replayed')
    expect(remote.posts).toBe(1)
  })
})

describe('a failure the remote genuinely did not see', () => {
  const identity = ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose: 'summary' })

  it('propagates, so the retry schedule and FR-076 exhaustion still apply', async () => {
    const remote = createTicketRemote()
    const ledger = createExternalActionLedger<string>()

    await expect(
      performExternalAction(ledger, {
        identity,
        find: remote.find,
        perform: (): Promise<string> => Promise.reject(new Error('connection refused')),
      }),
    ).rejects.toThrow('connection refused')

    expect(remote.posts).toBe(0)
  })

  it('records the action as pending, which is what a halt has to name (FR-076)', async () => {
    const remote = createTicketRemote()
    const ledger = createExternalActionLedger<string>()
    const action = {
      identity,
      find: remote.find,
      perform: (): Promise<string> => Promise.reject(new Error('connection refused')),
    }

    await expect(performExternalAction(ledger, action)).rejects.toThrow()
    await expect(performExternalAction(ledger, action)).rejects.toThrow()

    expect(pendingExternalActions(ledger)).toStrictEqual([
      { key: externalActionKey(identity), attempts: 2 },
    ])
  })

  it('does not let a failing recheck hide the failure that caused it', async () => {
    const ledger = createExternalActionLedger<string>()
    let looks = 0

    // The look-before-create succeeds and finds nothing; the remote then goes away, so neither the
    // attempt nor the recheck can complete. The original failure is what the caller needs to see —
    // reporting the lookup's error instead would describe the wrong request.
    await expect(
      performExternalAction(ledger, {
        identity,
        find: (): Promise<string | undefined> => {
          looks += 1
          return looks > 1
            ? Promise.reject(new Error('the remote is unreachable'))
            : Promise.resolve(undefined)
        },
        perform: (): Promise<string> => Promise.reject(new Error('connection refused')),
      }),
    ).rejects.toThrow('connection refused')

    expect(looks).toBe(2)
  })

  it('refuses to create when it could not look first, rather than creating blind', async () => {
    // A lookup that fails is not the same as a lookup that found nothing. Treating it as "nothing
    // there" and creating anyway is precisely how the second comment gets posted, so the failure
    // propagates and `perform` is never reached.
    const ledger = createExternalActionLedger<string>()
    let performs = 0

    await expect(
      performExternalAction(ledger, {
        identity,
        find: (): Promise<string | undefined> =>
          Promise.reject(new Error('the remote is unreachable')),
        perform: (): Promise<string> => {
          performs += 1
          return Promise.resolve('posted')
        },
      }),
    ).rejects.toThrow('the remote is unreachable')

    expect(performs).toBe(0)
  })
})

describe('an action whose remote cannot be asked', () => {
  const identity = ticketTransitionIdentity({ workflowId: RUN, ticket: 'ABC-1', status: 'review' })

  it('is still performed at most once per run once it has succeeded', async () => {
    const ledger = createExternalActionLedger<string>()
    let performs = 0
    const action = {
      identity,
      perform: (): Promise<string> => {
        performs += 1
        return Promise.resolve('moved')
      },
    }

    await performExternalAction(ledger, action)
    await performExternalAction(ledger, action)

    expect(performs).toBe(1)
  })

  it('cannot close the timeout gap, and says so by leaving the action pending', async () => {
    // Without a `find`, a failure is indistinguishable from a lost response and there is nobody to
    // ask. The action stays pending and the caller retries — which is why a port that *can* answer
    // should always supply one, and why `Forge` exposes `findPullRequest`.
    const ledger = createExternalActionLedger<string>()

    await expect(
      performExternalAction(ledger, {
        identity,
        perform: (): Promise<string> => Promise.reject(new Error('socket hang up')),
      }),
    ).rejects.toThrow('socket hang up')

    expect(pendingExternalActions(ledger)).toStrictEqual([
      { key: externalActionKey(identity), attempts: 1 },
    ])
  })
})

describe('the ledger', () => {
  it('keeps actions apart, so one landing does not settle another', async () => {
    const ledger = createExternalActionLedger<string>()
    const performed: string[] = []

    for (const purpose of ['summary', 'halted']) {
      await performExternalAction(ledger, {
        identity: ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose }),
        perform: (key): Promise<string> => {
          performed.push(key)
          return Promise.resolve(key)
        },
      })
    }

    expect(performed).toStrictEqual([
      `comment${EXTERNAL_ACTION_KEY_SEPARATOR}${RUN}${EXTERNAL_ACTION_KEY_SEPARATOR}ABC-1${EXTERNAL_ACTION_KEY_SEPARATOR}summary`,
      `comment${EXTERNAL_ACTION_KEY_SEPARATOR}${RUN}${EXTERNAL_ACTION_KEY_SEPARATOR}ABC-1${EXTERNAL_ACTION_KEY_SEPARATOR}halted`,
    ])
    expect(pendingExternalActions(ledger)).toStrictEqual([])
  })
})
