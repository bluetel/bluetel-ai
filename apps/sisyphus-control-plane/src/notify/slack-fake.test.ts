import { describe, expect, it } from 'vitest'

import { SlackDeliveryError } from './slack'
import { createFakeSlackMessenger } from './slack-fake'

/**
 * The fake has to behave like the seam it stands in for, or every suite built on it proves nothing.
 * In particular: an unnotifiable recipient **resolves with `undefined`**, and an outage **rejects**.
 * A fake that threw for both would let a delivery path that filed outages as `unnotifiable` pass.
 */
describe('createFakeSlackMessenger', () => {
  it('opens a stable channel per recipient and records what it sent', async () => {
    const slack = createFakeSlackMessenger()

    const first = await slack.openDirectMessage({ slackUserId: 'U1' })
    const second = await slack.openDirectMessage({ slackUserId: 'U1' })
    expect(first).toBe(second)

    await slack.postMessage({ channelId: first ?? '', text: 'one' })
    await slack.postMessage({ channelId: first ?? '', text: 'two' })

    expect(slack.opened).toStrictEqual(['U1', 'U1'])
    expect(slack.sent.map((message) => message.text)).toStrictEqual(['one', 'two'])
    expect(slack.sent[0]?.slackUserId).toBe('U1')
  })

  it('resolves with nothing for an unnotifiable recipient, as the real seam does', async () => {
    const slack = createFakeSlackMessenger({ unnotifiable: ['U2'] })

    await expect(slack.openDirectMessage({ slackUserId: 'U2' })).resolves.toBeUndefined()
    await expect(slack.openDirectMessage({ slackUserId: 'U1' })).resolves.toBeDefined()
  })

  it('can be made unnotifiable partway through', async () => {
    const slack = createFakeSlackMessenger()

    await expect(slack.openDirectMessage({ slackUserId: 'U3' })).resolves.toBeDefined()
    slack.makeUnnotifiable('U3')
    await expect(slack.openDirectMessage({ slackUserId: 'U3' })).resolves.toBeUndefined()
  })

  it('rejects both calls during an outage, and recovers when it is lifted', async () => {
    const slack = createFakeSlackMessenger({ failure: new Error('slack is down') })

    await expect(slack.openDirectMessage({ slackUserId: 'U1' })).rejects.toBeInstanceOf(
      SlackDeliveryError,
    )
    await expect(slack.postMessage({ channelId: 'D1', text: 'x' })).rejects.toThrow('slack is down')
    expect(slack.sent).toStrictEqual([])

    slack.failWith(undefined)
    await expect(slack.openDirectMessage({ slackUserId: 'U1' })).resolves.toBeDefined()
  })
})
