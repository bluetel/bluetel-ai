import type { WebClient } from '@slack/web-api'
import { describe, expect, it } from 'vitest'

import type {
  SlackConversationOpenResult,
  SlackDirectMessenger,
  SlackPostMessageResult,
  SlackWebApiClient,
} from './slack'
import {
  createWebApiSlackMessenger,
  isUnnotifiableSlackError,
  SlackDeliveryError,
  UNNOTIFIABLE_SLACK_ERRORS,
} from './slack'

/**
 * **No network, ever.** Every case below drives a hand-written client object; nothing in this file
 * constructs a `WebClient`, holds a token, or reaches Slack.
 *
 * The subject is the one judgement this module makes that nothing else can: which failures are
 * facts about the **recipient** (FR-140's `unnotifiable`) and which are facts about the
 * **platform** (a retryable `failed`). Getting that backwards either marks a whole outage's worth
 * of users permanently unreachable, or files one departed colleague as a recurring delivery
 * failure — and neither shows up as an error anywhere.
 */

/** A client whose two calls return whatever a case needs, recording what it was asked. */
const clientReturning = (options: {
  readonly open?: SlackConversationOpenResult
  readonly openThrows?: Error
  readonly post?: SlackPostMessageResult
  readonly postThrows?: Error
}): { readonly client: SlackWebApiClient; readonly calls: string[] } => {
  const calls: string[] = []

  return {
    calls,
    client: {
      conversations: {
        open: (args) => {
          calls.push(`open:${args.users}`)
          if (options.openThrows !== undefined) {
            throw options.openThrows
          }
          return Promise.resolve(options.open ?? { ok: true, channel: { id: 'D1' } })
        },
      },
      chat: {
        postMessage: (args) => {
          calls.push(`post:${args.channel}:${args.text}`)
          if (options.postThrows !== undefined) {
            throw options.postThrows
          }
          return Promise.resolve(options.post ?? { ok: true, ts: '1.0001' })
        },
      },
    },
  }
}

/** A Slack platform error, as `@slack/web-api` throws it: the code hides on `data.error`. */
const slackPlatformError = (code: string): Error => {
  const error = new Error(`An API error occurred: ${code}`)
  Reflect.set(error, 'data', { ok: false, error: code })
  return error
}

describe('the seam is narrower than the SDK', () => {
  it('accepts a real WebClient without importing one at run time', () => {
    // Type-only: this asserts at compile time that `WebClient` satisfies `SlackWebApiClient`, so
    // the adapter really can be handed the SDK's client — without constructing one, and therefore
    // without a token existing anywhere in the suite.
    const accept = (client: SlackWebApiClient): SlackWebApiClient => client
    const fromWebClient: (client: WebClient) => SlackWebApiClient = accept

    expect(typeof fromWebClient).toBe('function')
  })

  it('exposes exactly the two calls FR-136 needs', () => {
    const { client } = clientReturning({})
    const messenger: SlackDirectMessenger = createWebApiSlackMessenger({ client })

    expect(Object.keys(messenger).sort()).toStrictEqual(['openDirectMessage', 'postMessage'])
  })
})

describe('openDirectMessage', () => {
  it('opens the channel and returns its id', async () => {
    const { client, calls } = clientReturning({ open: { ok: true, channel: { id: 'D42' } } })

    await expect(
      createWebApiSlackMessenger({ client }).openDirectMessage({ slackUserId: 'U1' }),
    ).resolves.toBe('D42')
    expect(calls).toStrictEqual(['open:U1'])
  })

  it.each(UNNOTIFIABLE_SLACK_ERRORS)(
    'reports %s as unnotifiable rather than throwing (FR-140)',
    async (code) => {
      const returned = clientReturning({ open: { ok: false, error: code } })
      const thrown = clientReturning({ openThrows: slackPlatformError(code) })

      // Both shapes: Slack reports some of these in the body and some as a thrown platform error.
      await expect(
        createWebApiSlackMessenger(returned).openDirectMessage({ slackUserId: 'U1' }),
      ).resolves.toBeUndefined()
      await expect(
        createWebApiSlackMessenger(thrown).openDirectMessage({ slackUserId: 'U1' }),
      ).resolves.toBeUndefined()
    },
  )

  it('throws for a platform failure, so it is retried not filed against the user', async () => {
    const { client } = clientReturning({ openThrows: slackPlatformError('invalid_auth') })

    const failure: unknown = await createWebApiSlackMessenger({ client })
      .openDirectMessage({ slackUserId: 'U1' })
      .catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(SlackDeliveryError)
    expect(failure instanceof SlackDeliveryError ? failure.code : undefined).toBe('invalid_auth')
  })

  it('does not treat account_inactive as a fact about the recipient', () => {
    // It describes our own bot token. Filing it under FR-140 would mark the whole workspace
    // unreachable, one user at a time, and never retry.
    expect(isUnnotifiableSlackError('account_inactive')).toBe(false)
    expect(isUnnotifiableSlackError(undefined)).toBe(false)
    expect(isUnnotifiableSlackError('users_not_found')).toBe(true)
  })

  it('treats an ok response with no channel as unnotifiable', async () => {
    const { client } = clientReturning({ open: { ok: true, channel: {} } })

    await expect(
      createWebApiSlackMessenger({ client }).openDirectMessage({ slackUserId: 'U1' }),
    ).resolves.toBeUndefined()
  })
})

describe('postMessage', () => {
  it('posts to the opened channel and returns the timestamp', async () => {
    const { client, calls } = clientReturning({})

    await expect(
      createWebApiSlackMessenger({ client }).postMessage({ channelId: 'D42', text: 'hello' }),
    ).resolves.toBe('1.0001')
    expect(calls).toStrictEqual(['post:D42:hello'])
  })

  it('throws when Slack declines, rather than returning a value a caller might not check', async () => {
    const { client } = clientReturning({ post: { ok: false, error: 'msg_too_long' } })

    await expect(
      createWebApiSlackMessenger({ client }).postMessage({ channelId: 'D42', text: 'hello' }),
    ).rejects.toBeInstanceOf(SlackDeliveryError)
  })

  it('throws when Slack accepts but returns no timestamp', async () => {
    const { client } = clientReturning({ post: { ok: true } })

    await expect(
      createWebApiSlackMessenger({ client }).postMessage({ channelId: 'D42', text: 'hello' }),
    ).rejects.toBeInstanceOf(SlackDeliveryError)
  })

  it('keeps a transport failure legible', async () => {
    const { client } = clientReturning({ postThrows: new Error('socket hang up') })

    await expect(
      createWebApiSlackMessenger({ client }).postMessage({ channelId: 'D42', text: 'hello' }),
    ).rejects.toThrow('socket hang up')
  })
})
