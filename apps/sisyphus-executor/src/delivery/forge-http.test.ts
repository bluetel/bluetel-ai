/* cspell:words ratelimit */
import { describe, expect, it, vi } from 'vitest'

import type { Forge } from './forge'
import { ForgeError } from './forge-error'
import {
  createHttpForge,
  FORGE_API_VERSION,
  FORGE_API_VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  shaFromRefPayload,
} from './forge-http'
import { DEFAULT_FORGE_RETRY_POLICY } from './forge-retry'

/**
 * The one module in this directory that opens a socket — driven here by a fake
 * `fetch`, so it does not.
 *
 * Three things are worth settling, and they are the three the port's own doc
 * comment insists on:
 *
 * - **`undefined` means the host has no such branch, and never anything else.**
 *   Every other failure mode of `branchHead` is asserted to throw, because
 *   `pull-request.ts` renders `undefined` to the engineer as "your work was
 *   never pushed".
 * - **Creation cannot produce a duplicate**, including against a host that
 *   ignores the idempotency key, loses a response, or answers a second attempt
 *   with a conflict.
 * - **The credential is in a header and nowhere else** — not the url, not the
 *   returned object, not an error message (FR-072).
 */

const API = 'https://api.forge.example'
const CREDENTIAL = 'ghp_s3cr3tForgeTokenValue00000000000'
const REPOSITORY = 'https://forge.example/acme/web'
const BRANCH = 'sisyphus/ACME-142'
const BASE = 'develop'
const SHA = '9f1a0c4d5e6b7a8c9d0e1f2a3b4c5d6e7f809192'
const NOW = 1_700_000_000_000

interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

interface FakeAnswer {
  readonly status?: number
  readonly body?: unknown
  readonly text?: string
  readonly headers?: Record<string, string>
  /** Simulates a body that is not JSON at all. */
  readonly notJson?: boolean
}

/** A responder may answer, or reject the way a dead socket does. */
type Responder = (call: RecordedCall) => FakeAnswer | Error

interface Harness {
  readonly forge: Forge
  readonly calls: RecordedCall[]
  readonly slept: number[]
}

const posts = (calls: readonly RecordedCall[]): readonly RecordedCall[] =>
  calls.filter((call) => call.method === 'POST')

const harness = (responder: Responder, credential: () => string = () => CREDENTIAL): Harness => {
  const calls: RecordedCall[] = []
  const slept: number[] = []

  const fetch = vi.fn((input: URL | string, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }

    calls.push(call)

    const answer = responder(call)

    if (answer instanceof Error) {
      return Promise.reject(answer)
    }

    const status = answer.status ?? 200

    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(answer.headers ?? {}),
      json: () =>
        answer.notJson === true
          ? Promise.reject(new SyntaxError('Unexpected token <'))
          : Promise.resolve(answer.body ?? {}),
      text: () => Promise.resolve(answer.text ?? ''),
    } as Response)
  })

  return {
    calls,
    slept,
    forge: createHttpForge({
      apiBaseUrl: API,
      credential,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => NOW,
      retry: {
        ...DEFAULT_FORGE_RETRY_POLICY,
        sleep: async (milliseconds) => {
          slept.push(milliseconds)

          return Promise.resolve()
        },
      },
    }),
  }
}

const pullRequestBody = (number = 42, draft = true) => ({
  number,
  html_url: `https://forge.example/acme/web/pull/${String(number)}`,
  draft,
})

const refBody = { ref: `refs/heads/${BRANCH}`, object: { sha: SHA } }

const branch = { repository: REPOSITORY, branch: BRANCH }
const pair = { repository: REPOSITORY, head: BRANCH, base: BASE }

const creation = {
  repository: REPOSITORY,
  head: BRANCH,
  base: BASE,
  title: 'ACME-142 Add the thing',
  body: 'What changed and why.',
  draft: true,
  idempotencyKey: 'pull-request:run-1:acme/web:sisyphus/ACME-142:develop',
}

describe('shaFromRefPayload', () => {
  it('reads the commit off an exact ref answer', () => {
    expect(shaFromRefPayload(refBody, `heads/${BRANCH}`)).toBe(SHA)
  })

  it('picks the exact ref out of a prefix answer, never a sibling branch', () => {
    // A host that answers a ref lookup with everything sharing the prefix would
    // otherwise hand back `sisyphus/ACME-1420`'s commit for `sisyphus/ACME-142`.
    const payload = [
      { ref: 'refs/heads/sisyphus/ACME-1420', object: { sha: 'a'.repeat(40) } },
      refBody,
    ]

    expect(shaFromRefPayload(payload, `heads/${BRANCH}`)).toBe(SHA)
  })

  it('reports nothing when a prefix answer contains no exact match', () => {
    const payload = [{ ref: 'refs/heads/sisyphus/ACME-1420', object: { sha: 'a'.repeat(40) } }]

    expect(shaFromRefPayload(payload, `heads/${BRANCH}`)).toBeUndefined()
  })
})

describe('branchHead', () => {
  it('asks the ref endpoint, keeping the slashes in a branch name structural', async () => {
    const { forge, calls } = harness(() => ({ body: refBody }))

    expect(await forge.branchHead(branch)).toBe(SHA)
    expect(calls[0]?.url).toBe(`${API}/repos/acme/web/git/ref/heads/sisyphus/ACME-142`)
  })

  it('escapes a branch name rather than letting it climb out of the path', async () => {
    const { forge, calls } = harness(() => ({ body: refBody }))

    await forge.branchHead({ repository: REPOSITORY, branch: '..%2f../admin' })

    expect(calls[0]?.url).not.toContain('/../')
  })

  it('reports undefined when the host says there is no such branch', async () => {
    const { forge, calls } = harness(() => ({ status: 404, text: 'Not Found' }))

    expect(await forge.branchHead(branch)).toBeUndefined()
    // Not retried: 404 is an answer, not a failure.
    expect(calls).toHaveLength(1)
  })

  describe('never conflates a failed request with an absent branch', () => {
    it('throws on a server error rather than reporting no branch', async () => {
      const { forge, calls, slept } = harness(() => ({ status: 502, text: 'bad gateway' }))

      await expect(forge.branchHead(branch)).rejects.toThrow(/502/)
      expect(calls).toHaveLength(3)
      expect(slept).toStrictEqual([250, 500])
    })

    it('throws when the socket dies, rather than reporting no branch', async () => {
      const { forge } = harness(() => new TypeError('fetch failed'))
      let caught: unknown

      try {
        await forge.branchHead(branch)
      } catch (failure) {
        caught = failure
      }

      expect(caught).toBeInstanceOf(ForgeError)
      expect((caught as ForgeError).kind).toBe('transient')
    })

    it('throws on a credential problem rather than reporting no branch', async () => {
      const { forge, calls } = harness(() => ({ status: 401, text: 'Bad credentials' }))
      let caught: unknown

      try {
        await forge.branchHead(branch)
      } catch (failure) {
        caught = failure
      }

      expect((caught as ForgeError).kind).toBe('unauthorised')
      expect(calls).toHaveLength(1)
    })

    it('throws when the host answers a ref lookup with no commit in it', async () => {
      const { forge } = harness(() => ({ body: { ref: `refs/heads/${BRANCH}` } }))
      let caught: unknown

      try {
        await forge.branchHead(branch)
      } catch (failure) {
        caught = failure
      }

      expect((caught as ForgeError).kind).toBe('invalid')
    })

    it('throws when the answer is not JSON at all', async () => {
      const { forge } = harness(() => ({ notJson: true }))

      await expect(forge.branchHead(branch)).rejects.toThrow(/not JSON/)
    })
  })

  it('recovers from a single bad gateway rather than failing the run', async () => {
    let attempts = 0
    const { forge } = harness(() => {
      attempts += 1

      return attempts === 1 ? { status: 502, text: 'bad gateway' } : { body: refBody }
    })

    expect(await forge.branchHead(branch)).toBe(SHA)
  })

  it('waits as long as a throttling host asked, and no longer', async () => {
    let attempts = 0
    const { forge, slept } = harness(() => {
      attempts += 1

      return attempts === 1
        ? { status: 429, text: 'slow down', headers: { 'retry-after': '2' } }
        : { body: refBody }
    })

    expect(await forge.branchHead(branch)).toBe(SHA)
    expect(slept).toStrictEqual([2000])
  })

  it('refuses to wait out a reset longer than the policy allows', async () => {
    const { forge, slept } = harness(() => ({
      status: 403,
      text: 'rate limit exceeded',
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '1800' },
    }))
    let caught: unknown

    try {
      await forge.branchHead(branch)
    } catch (failure) {
      caught = failure
    }

    expect((caught as ForgeError).kind).toBe('rate_limited')
    expect(slept).toStrictEqual([])
  })
})

describe('findPullRequest', () => {
  it('asks only for an open pull request proposing this head onto this base', async () => {
    const { forge, calls } = harness(() => ({ body: [pullRequestBody()] }))

    expect(await forge.findPullRequest(pair)).toStrictEqual({
      number: 42,
      url: 'https://forge.example/acme/web/pull/42',
      isDraft: true,
    })

    const url = new URL(calls[0]?.url ?? '')

    expect(url.pathname).toBe('/repos/acme/web/pulls')
    expect(url.searchParams.get('state')).toBe('open')
    expect(url.searchParams.get('head')).toBe(`acme:${BRANCH}`)
    expect(url.searchParams.get('base')).toBe(BASE)
  })

  it('reports undefined when the host has no such pull request', async () => {
    const { forge } = harness(() => ({ body: [] }))

    expect(await forge.findPullRequest(pair)).toBeUndefined()
  })

  it('throws rather than reporting none when the repository itself is not found', async () => {
    const { forge } = harness(() => ({ status: 404, text: 'Not Found' }))

    // An inaccessible repository answering "no open pull request" is how a
    // second one gets opened on the next attempt.
    await expect(forge.findPullRequest(pair)).rejects.toThrow(/404/)
  })

  it('reports a pull request that is not a draft as such', async () => {
    const { forge } = harness(() => ({ body: [pullRequestBody(7, false)] }))

    expect((await forge.findPullRequest(pair))?.isDraft).toBe(false)
  })
})

describe('createPullRequest', () => {
  /**
   * A host that remembers. Every duplication test below runs against this
   * rather than against a canned response, because the failure being ruled out
   * is a *second row on the host*, which a stateless fake cannot express.
   */
  const fakeHost = (options: { readonly conflictOnDuplicate?: boolean } = {}) => {
    const pulls: ReturnType<typeof pullRequestBody>[] = []
    let hideNextList = false

    const responder: Responder = (call) => {
      if (call.method === 'POST') {
        if (pulls.length > 0 && options.conflictOnDuplicate === true) {
          return { status: 422, text: 'A pull request already exists for acme:sisyphus/ACME-142.' }
        }

        const created = pullRequestBody(pulls.length + 1)

        pulls.push(created)

        return { status: 201, body: created }
      }

      if (hideNextList) {
        hideNextList = false

        return { body: [] }
      }

      return { body: pulls }
    }

    return {
      responder,
      pulls,
      /** The next list answer is stale — the lost-response case. */
      hideNext: () => {
        hideNextList = true
      },
    }
  }

  it('posts the pull request the conventions describe, as a draft', async () => {
    const host = fakeHost()
    const { forge, calls } = harness(host.responder)

    expect(await forge.createPullRequest(creation)).toStrictEqual({
      number: 1,
      url: 'https://forge.example/acme/web/pull/1',
      isDraft: true,
    })

    const post = posts(calls)[0]

    expect(post.url).toBe(`${API}/repos/acme/web/pulls`)
    expect(JSON.parse(post.body ?? '{}')).toStrictEqual({
      title: creation.title,
      head: BRANCH,
      base: BASE,
      body: creation.body,
      draft: true,
    })
  })

  it('sends the idempotency key, for a host that honours one (FR-077)', async () => {
    const host = fakeHost()
    const { forge, calls } = harness(host.responder)

    await forge.createPullRequest(creation)

    expect(posts(calls)[0]?.headers[IDEMPOTENCY_KEY_HEADER]).toBe(creation.idempotencyKey)
  })

  it('looks before it creates, and returns what it found', async () => {
    const host = fakeHost()

    host.pulls.push(pullRequestBody(9))

    const { forge, calls } = harness(host.responder)

    expect((await forge.createPullRequest(creation)).number).toBe(9)
    expect(posts(calls)).toHaveLength(0)
  })

  describe('is safe to call twice', () => {
    it('opens one pull request when the same client is called twice in sequence', async () => {
      const host = fakeHost()
      const { forge, calls } = harness(host.responder)

      const first = await forge.createPullRequest(creation)
      const second = await forge.createPullRequest(creation)

      expect(second).toStrictEqual(first)
      expect(posts(calls)).toHaveLength(1)
      expect(host.pulls).toHaveLength(1)
    })

    it('opens one pull request when the same client is called twice at once', async () => {
      const host = fakeHost()
      const { forge, calls } = harness(host.responder)

      const [first, second] = await Promise.all([
        forge.createPullRequest(creation),
        forge.createPullRequest(creation),
      ])

      expect(second).toStrictEqual(first)
      expect(posts(calls)).toHaveLength(1)
      expect(host.pulls).toHaveLength(1)
    })

    it('opens one pull request across two clients, which is the retried-run case', async () => {
      // A retry after the instance was replaced has no memory of the first
      // attempt. Only looking before creating covers this one.
      const host = fakeHost()
      const first = harness(host.responder)
      const second = harness(host.responder)

      await first.forge.createPullRequest(creation)
      const again = await second.forge.createPullRequest(creation)

      expect(again.number).toBe(1)
      expect(posts(second.calls)).toHaveLength(0)
      expect(host.pulls).toHaveLength(1)
    })

    it('returns the existing one when a host that ignores the key answers with a conflict', async () => {
      // The lost-response case against an uncooperative host: the list is stale
      // for one call, so the attempt posts, is told it already exists, and
      // looks again rather than failing or posting twice.
      const host = fakeHost({ conflictOnDuplicate: true })

      host.pulls.push(pullRequestBody(5))

      const { forge, calls } = harness(host.responder)

      host.hideNext()

      expect((await forge.createPullRequest(creation)).number).toBe(5)
      expect(posts(calls)).toHaveLength(1)
      expect(host.pulls).toHaveLength(1)
    })

    it('does not post twice when the first response was lost to a bad gateway', async () => {
      // The host recorded the pull request and then failed to say so. The
      // retry's own look finds it, so the second attempt never posts.
      const pulls: ReturnType<typeof pullRequestBody>[] = []
      let swallowed = false

      const { forge, calls } = harness((call) => {
        if (call.method === 'POST') {
          pulls.push(pullRequestBody(pulls.length + 1))

          if (!swallowed) {
            swallowed = true

            return { status: 502, text: 'bad gateway' }
          }

          return { status: 201, body: pulls[pulls.length - 1] }
        }

        return { body: pulls }
      })

      expect((await forge.createPullRequest(creation)).number).toBe(1)
      expect(posts(calls)).toHaveLength(1)
      expect(pulls).toHaveLength(1)
    })
  })

  it('fails, rather than pretending, when a conflict names nothing that exists', async () => {
    const { forge } = harness((call) =>
      call.method === 'POST' ? { status: 422, text: 'base is invalid' } : { body: [] },
    )
    let caught: unknown

    try {
      await forge.createPullRequest(creation)
    } catch (failure) {
      caught = failure
    }

    expect((caught as ForgeError).kind).toBe('conflict')
    expect((caught as ForgeError).message).toContain('base is invalid')
  })

  it('lets a caller try again after a failure, and still opens only one', async () => {
    const pulls: ReturnType<typeof pullRequestBody>[] = []
    let refuse = true

    const { forge } = harness((call) => {
      if (call.method === 'POST') {
        if (refuse) {
          return { status: 401, text: 'Bad credentials' }
        }

        pulls.push(pullRequestBody(pulls.length + 1))

        return { status: 201, body: pulls[pulls.length - 1] }
      }

      return { body: pulls }
    })

    await expect(forge.createPullRequest(creation)).rejects.toThrow(/401/)

    refuse = false

    expect((await forge.createPullRequest(creation)).number).toBe(1)
    expect(pulls).toHaveLength(1)
  })

  it('opens a pull request ready for review when the request said so', async () => {
    const { forge, calls } = harness((call) =>
      call.method === 'POST' ? { status: 201, body: pullRequestBody(1, false) } : { body: [] },
    )

    const opened = await forge.createPullRequest({ ...creation, draft: false })

    expect(opened.isDraft).toBe(false)
    expect(JSON.parse(posts(calls)[0]?.body ?? '{}')).toMatchObject({ draft: false })
  })
})

describe('the credential', () => {
  it('travels in a header and appears in no url', async () => {
    const { forge, calls } = harness(() => ({ body: refBody }))

    await forge.branchHead(branch)

    expect(calls[0]?.headers.authorization).toBe(`Bearer ${CREDENTIAL}`)
    expect(calls[0]?.url).not.toContain('s3cr3t')
  })

  it('is not readable back off the client it was used to build', () => {
    const { forge } = harness(() => ({ body: refBody }))

    expect(JSON.stringify(Object.keys(forge))).not.toContain('credential')
    expect(JSON.stringify(forge)).not.toContain('s3cr3t')
  })

  it('is resolved per request, so a renewal is picked up without rebuilding', async () => {
    let current = CREDENTIAL
    const { forge, calls } = harness(
      () => ({ body: refBody }),
      () => current,
    )

    await forge.branchHead(branch)
    current = 'ghp_r3n3w3dForgeTokenValue0000000000'
    await forge.branchHead(branch)

    expect(calls[1]?.headers.authorization).toBe('Bearer ghp_r3n3w3dForgeTokenValue0000000000')
  })

  it('is redacted out of a failure that echoes it back (FR-072)', async () => {
    const { forge } = harness(() => ({
      status: 401,
      text: `Unauthorized for Bearer ${CREDENTIAL}`,
    }))
    let message = ''

    try {
      await forge.branchHead(branch)
    } catch (failure) {
      message = (failure as Error).message
    }

    expect(message).toContain('401')
    expect(message).not.toContain(CREDENTIAL)
    expect(message).toContain('[redacted')
  })
})

describe('the request the client makes', () => {
  it('pins the api version, so a host default moving cannot change what this means', async () => {
    const { forge, calls } = harness(() => ({ body: refBody }))

    await forge.branchHead(branch)

    expect(calls[0]?.headers[FORGE_API_VERSION_HEADER]).toBe(FORGE_API_VERSION)
    expect(calls[0]?.headers['user-agent']).toBe('sisyphus-executor')
  })

  it('addresses the same host whether or not the base url ends in a slash', async () => {
    const calls: string[] = []
    const fetch = vi.fn((input: URL | string) => {
      calls.push(String(input))

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(refBody),
        text: () => Promise.resolve(''),
      } as Response)
    })

    await createHttpForge({
      apiBaseUrl: `${API}//`,
      credential: () => CREDENTIAL,
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).branchHead(branch)

    expect(calls[0]).toBe(`${API}/repos/acme/web/git/ref/heads/sisyphus/ACME-142`)
  })

  it('refuses a repository reference it cannot address, before any request', async () => {
    const { forge, calls } = harness(() => ({ body: refBody }))

    await expect(
      forge.branchHead({ repository: 'https://forge.example/web', branch: BRANCH }),
    ).rejects.toThrow(/does not name an owner/)
    expect(calls).toHaveLength(0)
  })
})

describe('the implemented port', () => {
  it('has exactly the three methods, none of which touches a ticket (FR-060)', () => {
    const { forge } = harness(() => ({ body: refBody }))

    // The same assertion `forge.test.ts` makes about the interface, made about
    // the thing that actually talks to the host: the capability is absent, not
    // merely unused.
    expect(Object.keys(forge).sort()).toStrictEqual([
      'branchHead',
      'createPullRequest',
      'findPullRequest',
    ])
  })
})
