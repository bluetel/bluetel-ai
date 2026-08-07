/**
 * The Slack seam — what this platform needs from Slack, and nothing else (T084, FR-136).
 *
 * Two calls: `conversations.open` to get the direct-message channel for a person, then
 * `chat.postMessage` to put a message in it. Slack's Web API exposes some two hundred methods; this
 * interface exposes two, for the same reason the control plane's `src/aws/` exposes twelve across
 * four services — a seam
 * the width of the SDK is a re-export, and the delivery path would be untestable without a real
 * workspace and a real token.
 *
 * **No module in this package constructs a client.** The adapter is handed one, so importing the
 * barrel reaches no workspace, and the tests take {@link SlackDirectMessenger} through the
 * recording fake in `./slack-fake.ts` rather than over a network.
 *
 * ## Unnotifiable is an answer, not an error
 *
 * FR-140 says a user with no resolvable Slack identity is **recorded as unnotifiable, surfaced,
 * and must not cause the workflow to fail**. That distinction is drawn here rather than by the
 * caller, because only this module knows what Slack's error codes mean:
 * {@link openDirectMessage} returns `undefined` for the failures that are facts about the
 * *recipient* — no such Slack account, a deactivated one, a bot, a closed DM — and throws for the
 * failures that are facts about the *platform*, such as an expired bot token or a rate limit.
 * Confusing the two would either mark a whole outage's worth of users unnotifiable or turn one
 * departed colleague into a recurring delivery failure.
 */

/** The `conversations.open` fields this seam reads. Slack returns considerably more. */
export interface SlackConversationOpenResult {
  readonly ok?: boolean
  readonly error?: string
  readonly channel?: { readonly id?: string }
}

/** The `chat.postMessage` fields this seam reads. */
export interface SlackPostMessageResult {
  readonly ok?: boolean
  readonly error?: string
  readonly ts?: string
}

/**
 * The subset of `WebClient` the adapter uses.
 *
 * Declared with method syntax rather than property syntax so a real `WebClient` — whose arguments
 * are far wider than the two fields passed below — is assignable. `slack.test.ts` asserts that
 * assignability at compile time, with a type-only import and no token anywhere.
 */
export interface SlackWebApiClient {
  readonly conversations: {
    open(options: { users: string }): Promise<SlackConversationOpenResult>
  }
  readonly chat: {
    postMessage(options: { channel: string; text: string }): Promise<SlackPostMessageResult>
  }
}

/**
 * Slack error codes that describe the **recipient** rather than the platform (FR-140).
 *
 * Each one means this person cannot receive a direct message, and no amount of retrying changes
 * that. Anything outside this set — `invalid_auth`, `token_revoked`, `ratelimited`, a transport
 * failure — is a platform problem and is thrown, so it is recorded as `failed` and can be retried.
 *
 * `account_inactive` is deliberately absent: it describes *our own* bot token, not the recipient,
 * and filing it as unnotifiable would silently mark every user in the workspace unreachable.
 */
export const UNNOTIFIABLE_SLACK_ERRORS: readonly string[] = [
  'cannot_dm_bot',
  'is_bot',
  'user_disabled',
  'user_not_found',
  'user_not_visible',
  'users_not_found',
]

/** Whether a Slack error code means the recipient is unreachable rather than the API is. */
export const isUnnotifiableSlackError = (code: string | undefined): boolean =>
  code !== undefined && UNNOTIFIABLE_SLACK_ERRORS.includes(code)

/** A Slack call that failed for a reason retrying might fix. Never used for FR-140's case. */
export class SlackDeliveryError extends Error {
  /** Slack's own error code, where it gave one. */
  public readonly code: string | undefined

  public constructor(message: string, code?: string) {
    super(message)
    this.name = 'SlackDeliveryError'
    this.code = code
  }
}

/**
 * **The seam.** Two methods, both about one person receiving one message.
 *
 * Note what is *not* here: no channel posting, no user lookup by email, no workflow, no database.
 * A delivery path holding one of these can send a Slack message and do nothing else — which is the
 * mechanism behind FR-141, not a promise about how carefully it will be called.
 */
export interface SlackDirectMessenger {
  /**
   * The direct-message channel for a Slack user, or `undefined` when they cannot be direct-messaged
   * at all (FR-140).
   *
   * @param input - The recipient's Slack user id, as cached on `users.slack_user_id`.
   */
  readonly openDirectMessage: (input: {
    readonly slackUserId: string
  }) => Promise<string | undefined>

  /**
   * Post one message and return its timestamp.
   *
   * Throws {@link SlackDeliveryError} on failure. It never returns a "did not send" value, because
   * a caller that had to check one would eventually not.
   */
  readonly postMessage: (input: {
    readonly channelId: string
    readonly text: string
  }) => Promise<string>
}

/** Turn an unknown thrown value into a message, without losing its content. */
const describe = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown)

/**
 * Slack's error code, wherever it hid it.
 *
 * `@slack/web-api` throws a `WebAPIPlatformError` carrying `data.error`, but a transport failure
 * throws a plain `Error` with none, so this reads defensively rather than casting.
 */
const errorCodeOf = (thrown: unknown): string | undefined => {
  if (typeof thrown !== 'object' || thrown === null) {
    return undefined
  }

  const data: unknown = Reflect.get(thrown, 'data')
  if (typeof data === 'object' && data !== null) {
    const code: unknown = Reflect.get(data, 'error')
    if (typeof code === 'string') {
      return code
    }
  }

  const direct: unknown = Reflect.get(thrown, 'code')
  return typeof direct === 'string' ? direct : undefined
}

/**
 * Bind the seam to a Slack Web API client.
 *
 * @param options - The client. Constructed by the caller, so nothing in this directory holds a
 *   token.
 */
export const createWebApiSlackMessenger = (options: {
  readonly client: SlackWebApiClient
}): SlackDirectMessenger => {
  const { client } = options

  return {
    openDirectMessage: async (input) => {
      let result: SlackConversationOpenResult
      try {
        result = await client.conversations.open({ users: input.slackUserId })
      } catch (thrown) {
        const code = errorCodeOf(thrown)
        if (isUnnotifiableSlackError(code)) {
          return undefined
        }
        throw new SlackDeliveryError(describe(thrown), code)
      }

      if (result.ok === false) {
        if (isUnnotifiableSlackError(result.error)) {
          return undefined
        }
        throw new SlackDeliveryError(
          `Slack refused to open a direct message: ${result.error ?? 'unknown error'}.`,
          result.error,
        )
      }

      // `ok` without a channel id is not a delivery this can complete. Treated as unnotifiable
      // rather than thrown: the call succeeded and Slack simply has no channel for this person.
      return result.channel?.id
    },

    postMessage: async (input) => {
      let result: SlackPostMessageResult
      try {
        result = await client.chat.postMessage({ channel: input.channelId, text: input.text })
      } catch (thrown) {
        throw new SlackDeliveryError(describe(thrown), errorCodeOf(thrown))
      }

      if (result.ok === false || result.ts === undefined) {
        throw new SlackDeliveryError(
          `Slack did not accept the message: ${result.error ?? 'no timestamp returned'}.`,
          result.error,
        )
      }

      return result.ts
    },
  }
}
