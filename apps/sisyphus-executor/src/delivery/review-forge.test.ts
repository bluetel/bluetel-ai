/**
 * T196 — the review-side client, driven against a fake transport.
 *
 * No test here opens a socket. Three things are asserted beyond the round trip:
 *
 * - **A merged pull request reads as merged, not as closed.** Every host reports a merge as
 *   `state: "closed"`, and FR-080 turns on the difference — one means the work landed and the other
 *   means it was abandoned, and the guard's no-op reason says which.
 * - **A transport failure is never flattened into a state.** "The host could not be asked" must not
 *   become "the pull request is closed", which would stop a review that should have run.
 * - **The credential travels in a header and nowhere else**, and never reaches an error message.
 */

import { describe, expect, it } from 'vitest'

import { ForgeError } from './forge-error'
import { IDEMPOTENCY_KEY_HEADER } from './forge-http'
import { createHttpReviewForge, reviewTargetStateFrom } from './review-forge'

const CREDENTIAL = 'not-a-real-host-credential-0123456789'
const BASE = 'https://api.forge.example'
const REPOSITORY = 'https://forge.example/acme/service.git'

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

const forgeWith = (
  respond: (call: Call) => Response | Promise<Response>,
): { readonly forge: ReturnType<typeof createHttpReviewForge>; readonly calls: Call[] } => {
  const calls: Call[] = []

  const forge = createHttpReviewForge({
    apiBaseUrl: BASE,
    credential: () => CREDENTIAL,
    // No retries in these tests: the policy is `forge-retry.ts`'s and is tested there.
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async (input, init) => {
      const rawBody = init?.body
      const call: Call = {
        url: input instanceof URL ? input.toString() : (input as string),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
      }

      calls.push(call)

      return respond(call)
    },
  })

  return { forge, calls }
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

describe('reviewTargetStateFrom', () => {
  it('reads a merged pull request as merged even though its state is closed', () => {
    expect(reviewTargetStateFrom({ state: 'closed', merged: true })).toBe('merged')
    expect(reviewTargetStateFrom({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' })).toBe(
      'merged',
    )
  })

  it('reads an unmerged closed pull request as closed', () => {
    expect(reviewTargetStateFrom({ state: 'closed', merged: false, merged_at: null })).toBe(
      'closed',
    )
  })

  it('reads open as open', () => {
    expect(reviewTargetStateFrom({ state: 'open' })).toBe('open')
  })

  it('reads a state it does not recognise as unknown rather than as dead', () => {
    // `unknown` is not treated as dead by the guard, which is the safe direction: a host upgrade
    // must not turn into a run that reviewed nothing and called it success.
    expect(reviewTargetStateFrom({ state: 'locked' })).toBe('unknown')
  })
})

describe('createHttpReviewForge — readPullRequest', () => {
  it('asks the host for the pull request and reports its state and url', async () => {
    const { forge, calls } = forgeWith(() =>
      json({ number: 41, html_url: 'https://forge.example/acme/service/pull/41', state: 'open' }),
    )

    await expect(
      forge.readPullRequest({ repository: REPOSITORY, pullRequestNumber: 41 }),
    ).resolves.toStrictEqual({
      number: 41,
      url: 'https://forge.example/acme/service/pull/41',
      state: 'open',
    })

    expect(calls[0]?.url).toBe(`${BASE}/repos/acme/service/pulls/41`)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${CREDENTIAL}`)
  })

  it('throws rather than answering a state when the host was never asked', async () => {
    const { forge } = forgeWith(() => {
      throw new Error('socket hang up')
    })

    await expect(
      forge.readPullRequest({ repository: REPOSITORY, pullRequestNumber: 41 }),
    ).rejects.toBeInstanceOf(ForgeError)
  })

  it('throws for a pull request the host does not have', async () => {
    const { forge } = forgeWith(() => json({ message: 'Not Found' }, 404))

    await expect(
      forge.readPullRequest({ repository: REPOSITORY, pullRequestNumber: 999 }),
    ).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('createHttpReviewForge — publishFindings', () => {
  it('posts the comment and reports where it landed', async () => {
    const { forge, calls } = forgeWith(() =>
      json({ html_url: 'https://forge.example/acme/service/pull/41#issuecomment-9' }, 201),
    )

    await expect(
      forge.publishFindings({
        repository: REPOSITORY,
        pullRequestNumber: 41,
        body: 'Two blockers below.',
        idempotencyKey: 'review-comment:run:acme/service:41',
      }),
    ).resolves.toStrictEqual({
      repository: REPOSITORY,
      pullRequestNumber: 41,
      url: 'https://forge.example/acme/service/pull/41#issuecomment-9',
    })

    expect(calls[0]?.url).toBe(`${BASE}/repos/acme/service/issues/41/comments`)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toStrictEqual({ body: 'Two blockers below.' })
    expect(calls[0]?.headers[IDEMPOTENCY_KEY_HEADER]).toBe('review-comment:run:acme/service:41')
  })

  it('posts the agent’s body verbatim and adds nothing to it', async () => {
    const body = '## Findings\n\n- [blocker] the migration is missing'
    const { forge, calls } = forgeWith(() => json({ html_url: 'https://forge.example/c/1' }, 201))

    await forge.publishFindings({
      repository: REPOSITORY,
      pullRequestNumber: 41,
      body,
      idempotencyKey: 'k',
    })

    expect((calls[0]?.body as { body: string }).body).toBe(body)
  })

  it('says the comment may already have landed when the host answers without a url', async () => {
    const { forge } = forgeWith(() => json({}, 201))

    await expect(
      forge.publishFindings({
        repository: REPOSITORY,
        pullRequestNumber: 41,
        body: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('a retry will not post a second')
  })

  it('never puts the credential in an error message', async () => {
    const { forge } = forgeWith(() => new Response(`bad credential ${CREDENTIAL}`, { status: 401 }))

    const error = await forge
      .publishFindings({
        repository: REPOSITORY,
        pullRequestNumber: 41,
        body: 'x',
        idempotencyKey: 'k',
      })
      .catch((thrown: unknown) => thrown)

    expect(String(error)).not.toContain(CREDENTIAL)
  })
})
