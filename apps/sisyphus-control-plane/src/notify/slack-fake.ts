import type { SlackDirectMessenger } from './slack'
import { SlackDeliveryError } from './slack'

/**
 * Recording fake for {@link SlackDirectMessenger}.
 *
 * **The only Slack any test in this repository talks to.** There is no network call anywhere in
 * the notify suites, and no fixture holds a token — a Slack outage or a revoked credential must not
 * be able to turn a test run red, and the delivery-failure paths this fake exists to exercise
 * cannot be produced on demand against a real workspace anyway.
 *
 * It records the *sent* messages in order, and the ids it was asked to open a channel for, because
 * the assertions that matter are about coalescing — "one message, not four" — which a fake that
 * only remembered the last call could not express.
 */

/** One message as it was delivered. */
export interface RecordedSlackMessage {
  readonly slackUserId: string
  readonly channelId: string
  readonly text: string
}

export interface FakeSlackMessenger extends SlackDirectMessenger {
  /** Every message accepted, oldest first. */
  readonly sent: readonly RecordedSlackMessage[]
  /** Slack user ids `openDirectMessage` was called with, in order, refusals included. */
  readonly opened: readonly string[]
  /** Make Slack decline to open a direct message with this recipient — FR-140's case. */
  readonly makeUnnotifiable: (slackUserId: string) => void
  /** Make every call fail as a platform problem, as an outage would. */
  readonly failWith: (error: Error | undefined) => void
}

export interface FakeSlackMessengerOptions {
  /** Recipients that cannot be direct-messaged from the start. */
  readonly unnotifiable?: readonly string[]
  /** A failure applied to every call from the start. */
  readonly failure?: Error
}

export const createFakeSlackMessenger = (
  options: FakeSlackMessengerOptions = {},
): FakeSlackMessenger => {
  const sent: RecordedSlackMessage[] = []
  const opened: string[] = []
  const unnotifiable = new Set(options.unnotifiable ?? [])
  const channels = new Map<string, string>()
  let failure = options.failure

  /** Which recipient a channel belongs to, so `sent` can record it without the caller passing it. */
  const ownerOf = (channelId: string): string => {
    for (const [slackUserId, channel] of channels) {
      if (channel === channelId) {
        return slackUserId
      }
    }
    return 'unknown'
  }

  return {
    sent,
    opened,

    makeUnnotifiable: (slackUserId) => {
      unnotifiable.add(slackUserId)
    },

    failWith: (error) => {
      failure = error
    },

    openDirectMessage: (input) => {
      opened.push(input.slackUserId)

      if (failure !== undefined) {
        return Promise.reject(new SlackDeliveryError(failure.message))
      }
      if (unnotifiable.has(input.slackUserId)) {
        return Promise.resolve(undefined)
      }

      const channelId = channels.get(input.slackUserId) ?? `D${input.slackUserId}`
      channels.set(input.slackUserId, channelId)
      return Promise.resolve(channelId)
    },

    postMessage: (input) => {
      if (failure !== undefined) {
        return Promise.reject(new SlackDeliveryError(failure.message))
      }

      sent.push({
        slackUserId: ownerOf(input.channelId),
        channelId: input.channelId,
        text: input.text,
      })
      return Promise.resolve(`${sent.length}.000100`)
    },
  }
}
