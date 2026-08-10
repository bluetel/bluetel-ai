import type { StartSessionCommandOutput, TerminateSessionCommandOutput } from '@aws-sdk/client-ssm'
import { StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm'

/**
 * The relayed session — how an administrator drives the agent's own login inside an instance they
 * have no other access to (T075, FR-069, FR-070).
 *
 * ## Why SSM Session Manager and not SSH
 *
 * The login environment has no key pair, no inbound security group rule and no public address, and
 * it is not meant to acquire any. A session is opened *outbound* by the agent already on the
 * instance, brokered by AWS, and authorised by the platform's own IAM role — so relaying a terminal
 * to an administrator costs nothing in reachability, and an environment that is destroyed is
 * genuinely unreachable rather than merely unadvertised.
 *
 * It also means the relay handle is scoped by AWS rather than by us: `StartSession` answers with a
 * stream URL and a token that are worth one session on one instance, expire on their own, and can
 * be revoked by terminating the session.
 *
 * ## What crosses to the browser, and why it is not what FR-070 forbids
 *
 * The three fields of {@link RelayedSession} reach the administrator's browser, because that is
 * where the terminal is drawn. They are a credential for a *terminal* — one session, one instance,
 * short-lived — and not credential material of any kind. FR-070 is about the agent credential the
 * administrator is creating, which is written by the agent into a file on the instance, read from
 * there by `capture.ts`, and put into Secrets Manager. It is never in a response.
 *
 * The instance the terminal reaches holds no workspace, no setup bundle and no other seat's
 * material (see `environment.ts`), so the blast radius of the handle is the login it was issued for.
 *
 * ## Closing is best-effort, and destroying the instance is the real revocation
 *
 * {@link closeRelayedSession} exists so a completed login does not leave a session idling, but it
 * is not what makes the terminal stop working — terminating the instance is, and FR-071 requires
 * that on success, failure and abandonment alike. A relay that could only be revoked by an API call
 * would be one that survived every failure of that API call.
 */

/** What an administrator's browser needs in order to attach a terminal. Never material. */
export interface RelayedSession {
  readonly sessionId: string
  readonly streamUrl: string
  readonly tokenValue: string
}

/**
 * The subset of `SSMClient` this adapter uses.
 *
 * Two overloads rather than `Pick<SSMClient, 'send'>`, for the reason `Ec2CommandSender` gives: the
 * SDK's generic `send` is awkward to implement by hand, and a fake that needs a cast to exist is a
 * fake nobody writes.
 */
export interface SsmSessionCommandSender {
  send(command: StartSessionCommand): Promise<StartSessionCommandOutput>
  send(command: TerminateSessionCommand): Promise<TerminateSessionCommandOutput>
}

/** Opening and closing the terminal an administrator drives the login through. */
export interface LoginRelay {
  readonly open: (input: { readonly environmentId: string }) => Promise<RelayedSession>
  /** Best-effort. See the module note on why the instance, not this, is the revocation. */
  readonly close: (input: { readonly sessionId: string }) => Promise<void>
}

export const createSsmLoginRelay = (options: {
  readonly client: SsmSessionCommandSender
}): LoginRelay => {
  const { client } = options

  return {
    open: async (input) => {
      const output = await client.send(new StartSessionCommand({ Target: input.environmentId }))

      const { SessionId: sessionId, StreamUrl: streamUrl, TokenValue: tokenValue } = output

      if (
        sessionId === undefined ||
        sessionId === '' ||
        streamUrl === undefined ||
        streamUrl === '' ||
        tokenValue === undefined ||
        tokenValue === ''
      ) {
        // A partial handle is not a degraded terminal, it is no terminal — and answering with one
        // would put an administrator in front of a console that never connects, with the login
        // environment billing behind it until the reaper takes it. Failing here means the caller
        // destroys the environment now and records a reason against the seat (FR-009).
        throw new Error(
          `SSM started a session on ${input.environmentId} but did not return all three of the session id, the stream URL and the token. There is no terminal to hand back, and an administrator given a partial one would wait at a console that cannot connect.`,
        )
      }

      return { sessionId, streamUrl, tokenValue }
    },

    close: async (input) => {
      await client.send(new TerminateSessionCommand({ SessionId: input.sessionId }))
    },
  }
}
