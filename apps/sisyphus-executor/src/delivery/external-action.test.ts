import { describe, expect, it } from 'vitest'

import type { ExternalActionInput } from '../report'

import type { ExternalActionIdentity, ExternalActionRecorder } from './external-action'
import {
  createExternalActionLedger,
  EXTERNAL_ACTION_KEY_SEPARATOR,
  externalActionKey,
  ExternalActionNotEntitledError,
  externalActionTargetReference,
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
  kind: 'comment_posted',
})

const ticketTransitionIdentity = (input: {
  readonly workflowId: string
  readonly ticket: string
  readonly status: string
}): ExternalActionIdentity => ({
  action: 'transition',
  workflowId: input.workflowId,
  target: [input.ticket, input.status],
  kind: 'ticket_transitioned',
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

/**
 * **The durable half (FR-076).**
 *
 * These are the tests that would have caught the gap T180 named: the in-memory ledger is per
 * process, so every test above passes just as happily with an instance that was re-provisioned
 * mid-delivery and came back knowing nothing. What makes the guarantee cross-process is the row
 * and its unique index, and the only way to test that from here is to stand up a fake of the
 * machine surface that behaves like the index does — one winner per key, and a `succeeded` row
 * that nobody may act over.
 */
const createFakeExternalActionSurface = (): ExternalActionRecorder & {
  readonly rows: Map<string, { result: ExternalActionInput['result']; attemptCount: number }>
  readonly calls: ExternalActionInput[]
} => {
  const rows = new Map<string, { result: ExternalActionInput['result']; attemptCount: number }>()
  const calls: ExternalActionInput[] = []

  return {
    rows,
    calls,
    reportExternalAction: async (input) => {
      calls.push(input)
      const key = `${input.kind}:${input.idempotencyKey}`
      const stored = rows.get(key)

      if (stored === undefined) {
        rows.set(key, { result: input.result, attemptCount: input.attemptCount })

        return Promise.resolve({
          action: {} as never,
          claimed: true,
          alreadyPerformed: input.result === 'succeeded',
        })
      }

      // The progression rule the procedure enforces: `succeeded` is terminal, nothing regresses
      // to `pending`, and the attempt count moves under `greatest`.
      const result =
        stored.result === 'succeeded' || input.result === 'pending' ? stored.result : input.result

      rows.set(key, {
        result,
        attemptCount: Math.max(stored.attemptCount, input.attemptCount),
      })

      return Promise.resolve({
        action: {} as never,
        claimed: false,
        alreadyPerformed: result === 'succeeded',
      })
    },
  }
}

describe('the durable ledger', () => {
  const identity = ticketCommentIdentity({ workflowId: RUN, ticket: 'ABC-1', purpose: 'summary' })

  it('says whether it is durable at all, rather than leaving it to be inferred', () => {
    expect(createExternalActionLedger<string>().isDurable).toBe(false)
    expect(
      createExternalActionLedger<string>({ recorder: createFakeExternalActionSurface() }).isDurable,
    ).toBe(true)
  })

  it('claims the action before performing it, never after', async () => {
    const surface = createFakeExternalActionSurface()
    const ledger = createExternalActionLedger<string>({ recorder: surface })
    const order: string[] = []

    await performExternalAction(ledger, {
      identity,
      perform: (): Promise<string> => {
        order.push(`perform after ${String(surface.calls.length)} report(s)`)
        return Promise.resolve('posted')
      },
    })

    // The claim is only useful if it is the thing that gates the action. A ledger that reported
    // afterwards would be a log, and a second process asking would already be too late.
    expect(surface.calls[0]).toMatchObject({ result: 'pending', attemptCount: 1 })
    expect(order).toStrictEqual(['perform after 1 report(s)'])
    expect(surface.calls[1]).toMatchObject({ result: 'succeeded' })
  })

  it('sends the derived key and the platform kind, so the index is scoped as the schema is', async () => {
    const surface = createFakeExternalActionSurface()
    const ledger = createExternalActionLedger<string>({ recorder: surface })

    await performExternalAction(ledger, {
      identity,
      perform: (): Promise<string> => Promise.resolve('posted'),
    })

    expect(surface.calls[0]).toMatchObject({
      kind: 'comment_posted',
      idempotencyKey: externalActionKey(identity),
      targetReference: externalActionTargetReference(identity),
    })
  })

  /**
   * The failure the whole change exists to prevent, and the one no in-memory test can reach: the
   * instance is reclaimed mid-delivery and replaced. The replacement's map is empty and its remote
   * cannot be asked, so before T180 it re-posted.
   */
  it('refuses to act after a re-provision, when the row says the action already landed', async () => {
    const surface = createFakeExternalActionSurface()
    let performs = 0
    const perform = (): Promise<string> => {
      performs += 1
      return Promise.resolve('posted')
    }

    await performExternalAction(createExternalActionLedger<string>({ recorder: surface }), {
      identity,
      perform,
    })

    // A fresh instance: a fresh ledger, an empty map, the same durable row.
    const replacement = createExternalActionLedger<string>({ recorder: surface })

    await expect(performExternalAction(replacement, { identity, perform })).rejects.toBeInstanceOf(
      ExternalActionNotEntitledError,
    )
    expect(performs).toBe(1)
  })

  it('lets a re-provisioned run recover the result when the remote can be asked', async () => {
    const surface = createFakeExternalActionSurface()
    const remote = createTicketRemote()

    await performExternalAction(createExternalActionLedger<string>({ recorder: surface }), {
      identity,
      find: remote.find,
      perform: (): Promise<string> => remote.post('the summary'),
    })

    // `find` runs before the claim, so a remote that can answer produces the result rather than a
    // refusal — the durable row records that an action happened, not what it produced.
    const outcome = await performExternalAction(
      createExternalActionLedger<string>({ recorder: surface }),
      { identity, find: remote.find, perform: (): Promise<string> => remote.post('the summary') },
    )

    expect(outcome.disposition).toBe('already-performed')
    expect(remote.posts).toBe(1)
  })

  it('refuses the loser of a race for one key, so two live instances cannot both act', async () => {
    const surface = createFakeExternalActionSurface()
    let performs = 0
    const perform = async (): Promise<string> => {
      performs += 1

      return new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('posted')
        }, 0)
      })
    }

    const [first, second] = await Promise.allSettled([
      performExternalAction(createExternalActionLedger<string>({ recorder: surface }), {
        identity,
        perform,
      }),
      performExternalAction(createExternalActionLedger<string>({ recorder: surface }), {
        identity,
        perform,
      }),
    ])

    expect([first.status, second.status].sort()).toStrictEqual(['fulfilled', 'rejected'])
    expect(performs).toBe(1)
  })

  it('names which refusal it is, because the two mean different things afterwards', async () => {
    const surface = createFakeExternalActionSurface()

    const post = (): Promise<string> => Promise.resolve('posted')

    await performExternalAction(createExternalActionLedger<string>({ recorder: surface }), {
      identity,
      perform: post,
    })

    const refused = await performExternalAction(
      createExternalActionLedger<string>({ recorder: surface }),
      { identity, perform: post },
    ).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ExternalActionNotEntitledError)
    expect((refused as ExternalActionNotEntitledError).refusal).toBe('already-performed')
  })

  it('reports a genuine failure as failed rather than leaving the row claimed for ever', async () => {
    const surface = createFakeExternalActionSurface()
    const ledger = createExternalActionLedger<string>({ recorder: surface })

    await expect(
      performExternalAction(ledger, {
        identity,
        find: (): Promise<string | undefined> => Promise.resolve(undefined),
        perform: (): Promise<string> => Promise.reject(new Error('connection refused')),
      }),
    ).rejects.toThrow('connection refused')

    // A row stuck on `pending` would make this run's own retry look like somebody else's claim.
    expect(surface.calls.at(-1)).toMatchObject({ result: 'failed', attemptCount: 1 })
  })

  it('changes nothing for a ledger with no recorder, so adoption is call site by call site', async () => {
    const ledger = createExternalActionLedger<string>()
    let performs = 0

    const outcome = await performExternalAction(ledger, {
      identity,
      perform: (): Promise<string> => {
        performs += 1
        return Promise.resolve('posted')
      },
    })

    expect(outcome.disposition).toBe('performed')
    expect(performs).toBe(1)
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
