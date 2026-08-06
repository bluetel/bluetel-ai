import { describe, expect, it, vi } from 'vitest'

import {
  authorisationHeader,
  createJiraHttpClient,
  DISCOVERY_FIELDS,
  JIRA_API_BASE,
  requestFailedError,
} from './client-http'

/**
 * The one module in this package that opens a socket — driven here by a fake `fetch`, so it does
 * not.
 *
 * What is worth settling is everything the seam's shape leaves to the adapter: that it speaks v2,
 * that it asks for the fields `./candidate.ts` actually projects rather than every field on the
 * screen, that paging arguments arrive as Jira spells them, and — the one with a requirement behind
 * it — that the credential is in a header and never anywhere a log or a run record can reach
 * (FR-072, FR-098).
 */

const BASE = 'https://acme.atlassian.net'
const TOKEN = 'someone@acme.test:s3cr3t-api-token'

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

const fakeFetch = (
  responder: (url: string) => { status?: number; body?: unknown; text?: string } = () => ({}),
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = []

  const fetch = vi.fn((input: URL | string, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })

    const answer = responder(url)
    const status = answer.status ?? 200

    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(answer.body ?? {}),
      text: () => Promise.resolve(answer.text ?? ''),
    } as Response)
  })

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const headerOf = (call: RecordedCall | undefined, name: string): string | undefined =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name]

describe('authorisationHeader', () => {
  it('sends an email and token pair as Basic, which is how Jira Cloud authenticates', () => {
    expect(authorisationHeader('someone@acme.test:tok')).toBe(
      `Basic ${Buffer.from('someone@acme.test:tok', 'utf8').toString('base64')}`,
    )
  })

  it('sends a bare token as Bearer, which is how a personal access token authenticates', () => {
    expect(authorisationHeader('pat-abc123')).toBe('Bearer pat-abc123')
  })
})

describe('createJiraHttpClient', () => {
  it('speaks v2, because the seam is written against plain-text bodies', async () => {
    const { fetch, calls } = fakeFetch()

    await createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).currentUser()

    expect(calls[0]?.url).toBe(`${BASE}${JIRA_API_BASE}/myself`)
    expect(JIRA_API_BASE).toBe('/rest/api/2')
  })

  it('addresses the same board whether or not the base URL ends in a slash', async () => {
    const { fetch, calls } = fakeFetch()

    await createJiraHttpClient({
      baseUrl: `${BASE}/`,
      credential: TOKEN,
      fetch,
    }).currentUser()

    expect(calls[0]?.url).toBe(`${BASE}${JIRA_API_BASE}/myself`)
  })

  it('asks for the fields the candidate projection reads, not every field on the screen', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { issues: [] } }))

    await createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).searchIssues({
      jql: 'project = ACME',
      startAt: 50,
      maxResults: 25,
    })

    const url = new URL(calls[0]?.url ?? '')

    expect(url.pathname).toBe(`${JIRA_API_BASE}/search`)
    expect(url.searchParams.get('jql')).toBe('project = ACME')
    expect(url.searchParams.get('startAt')).toBe('50')
    expect(url.searchParams.get('maxResults')).toBe('25')
    expect(url.searchParams.get('fields')).toBe(DISCOVERY_FIELDS.join(','))
    // The comments go into the prompt, so they have to be asked for.
    expect(DISCOVERY_FIELDS).toContain('comment')
  })

  it('pages comments oldest first, which is the order write-back walks them in', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { comments: [] } }))

    await createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).listComments({
      issueKey: 'ACME-12',
      startAt: 0,
      maxResults: 50,
    })

    const url = new URL(calls[0]?.url ?? '')

    expect(url.pathname).toBe(`${JIRA_API_BASE}/issue/ACME-12/comment`)
    expect(url.searchParams.get('orderBy')).toBe('created')
  })

  it('escapes an issue key rather than pasting it into a path', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { comments: [] } }))

    await createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).listComments({
      issueKey: 'ACME/../admin',
      startAt: 0,
      maxResults: 1,
    })

    expect(calls[0]?.url).toContain(encodeURIComponent('ACME/../admin'))
    expect(calls[0]?.url).not.toContain('ACME/../')
  })

  it('posts a comment as a plain-text body and offers an idempotency key', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { id: '10001' } }))

    const posted = await createJiraHttpClient({
      baseUrl: BASE,
      credential: TOKEN,
      fetch,
    }).addComment({ issueKey: 'ACME-12', body: 'Picked this up.', idempotencyKey: 'k-1' })

    expect(posted.id).toBe('10001')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ body: 'Picked this up.' }))
    expect(headerOf(calls[0], 'x-idempotency-key')).toBe('k-1')
  })

  describe('the credential', () => {
    it('travels in a header and nowhere else', async () => {
      const { fetch, calls } = fakeFetch(() => ({ body: { issues: [] } }))

      await createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).searchIssues({
        jql: 'project = ACME',
        startAt: 0,
        maxResults: 1,
      })

      expect(headerOf(calls[0], 'authorization')).toBe(authorisationHeader(TOKEN))
      expect(calls[0]?.url).not.toContain('s3cr3t')
      expect(calls[0]?.url).not.toContain('someone@acme.test')
    })

    it('is not readable back off the client it was used to build', () => {
      const client = createJiraHttpClient({
        baseUrl: BASE,
        credential: TOKEN,
        fetch: fakeFetch().fetch,
      })

      expect(JSON.stringify(Object.keys(client))).not.toContain('credential')
      expect(JSON.stringify(client)).not.toContain('s3cr3t')
    })

    it('is redacted out of a failure that echoes it back (FR-072, FR-098)', () => {
      const error = requestFailedError(
        'searchIssues',
        401,
        `Unauthorized for ${authorisationHeader(TOKEN)}`,
      )

      expect(error.message).toContain('401')
      expect(error.message).not.toContain('s3cr3t')
      expect(error.message).toContain('[redacted]')
    })
  })

  describe('a refused request', () => {
    it('names the status, which is the thing an admin can act on', async () => {
      const { fetch } = fakeFetch(() => ({ status: 400, text: 'jql is invalid' }))

      await expect(
        createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).searchIssues({
          jql: 'nonsense',
          startAt: 0,
          maxResults: 1,
        }),
      ).rejects.toThrow(/400/)
    })

    it('does not put the query, and so the board configuration, in the message', async () => {
      const { fetch } = fakeFetch(() => ({ status: 400, text: '' }))
      let message = ''

      try {
        await createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).searchIssues({
          jql: 'labels = super-secret-programme',
          startAt: 0,
          maxResults: 1,
        })
      } catch (caught) {
        message = (caught as Error).message
      }

      expect(message).toContain('400')
      expect(message).not.toContain('super-secret-programme')
      expect(message).not.toContain(BASE)
    })

    it('reports the status rather than a parse error when the body is not JSON', async () => {
      const { fetch } = fakeFetch(() => ({ status: 502, text: '<html>gateway</html>' }))

      await expect(
        createJiraHttpClient({ baseUrl: BASE, credential: TOKEN, fetch }).currentUser(),
      ).rejects.toThrow(/502/)
    })
  })

  it('never transitions an issue — the capability is absent, not unused (FR-057)', () => {
    const client = createJiraHttpClient({
      baseUrl: BASE,
      credential: TOKEN,
      fetch: fakeFetch().fetch,
    })

    expect(Object.keys(client).sort()).toStrictEqual([
      'addComment',
      'currentUser',
      'listComments',
      'searchIssues',
    ])
  })
})
