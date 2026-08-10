import type {
  SSMClient,
  StartSessionCommandOutput,
  TerminateSessionCommand,
  TerminateSessionCommandOutput,
} from '@aws-sdk/client-ssm'
import { StartSessionCommand } from '@aws-sdk/client-ssm'
import { describe, expect, it } from 'vitest'

import type { SsmSessionCommandSender } from './relay'
import { createSsmLoginRelay } from './relay'

/**
 * The relayed session (T075, FR-069, FR-070).
 *
 * Exercised against a stub sender that records commands and returns canned output. Nothing here
 * constructs an `SSMClient`, reads a region or touches an account — the same claim every adapter in
 * `aws/` makes, and a test that needed a real instance to run would disprove it.
 */

const metadata = { $metadata: {} }

/** A hand-written `SSMClient` stand-in. A class, because the seam is declared as overloads. */
class StubSsmSender {
  public readonly commands: object[] = []

  public constructor(private readonly startSession: StartSessionCommandOutput | undefined) {}

  public send(command: StartSessionCommand): Promise<StartSessionCommandOutput>
  public send(command: TerminateSessionCommand): Promise<TerminateSessionCommandOutput>
  public send(command: object): Promise<object> {
    this.commands.push(command)

    if (command instanceof StartSessionCommand) {
      return Promise.resolve(
        this.startSession ?? {
          ...metadata,
          SessionId: 'session-1',
          StreamUrl: 'wss://ssmmessages.eu-west-2.amazonaws.com/v1/data-channel/session-1',
          TokenValue: 'ssm-session-token',
        },
      )
    }

    return Promise.resolve(metadata)
  }
}

/** Compile-time proof that the production client satisfies the seam it is handed to. */
export const sendIsAssignable = (client: SSMClient): SsmSessionCommandSender => client

describe('the SSM login relay', () => {
  it('opens a session against the login instance and hands back the three fields', async () => {
    const sender = new StubSsmSender(undefined)

    const session = await createSsmLoginRelay({ client: sender }).open({
      environmentId: 'i-login-1',
    })

    expect(session).toStrictEqual({
      sessionId: 'session-1',
      streamUrl: 'wss://ssmmessages.eu-west-2.amazonaws.com/v1/data-channel/session-1',
      tokenValue: 'ssm-session-token',
    })
    expect((sender.commands[0] as StartSessionCommand).input).toStrictEqual({
      Target: 'i-login-1',
    })
  })

  it('carries nothing but the terminal handle — there is nowhere to put material', async () => {
    const session = await createSsmLoginRelay({ client: new StubSsmSender(undefined) }).open({
      environmentId: 'i-login-1',
    })

    // FR-070 asserted on the shape rather than on behaviour with a value the relay never sees. The
    // agent credential is written on the instance and read from there by `capture.ts`; nothing on
    // the path to the browser is capable of carrying it.
    expect(Object.keys(session).sort()).toStrictEqual(['sessionId', 'streamUrl', 'tokenValue'])
  })

  it('refuses a partial handle rather than handing back a console that cannot connect', async () => {
    const sender = new StubSsmSender({
      ...metadata,
      SessionId: 'session-1',
      StreamUrl: '',
      TokenValue: 'ssm-session-token',
    })

    // An administrator given a partial handle waits at a terminal that never opens, with the login
    // environment billing behind it. Failing here is what lets the caller destroy it now.
    await expect(
      createSsmLoginRelay({ client: sender }).open({ environmentId: 'i-login-1' }),
    ).rejects.toThrow(/did not return all three/)
  })

  it('closes a session by id', async () => {
    const sender = new StubSsmSender(undefined)

    await createSsmLoginRelay({ client: sender }).close({ sessionId: 'session-1' })

    expect((sender.commands[0] as { input: unknown }).input).toStrictEqual({
      SessionId: 'session-1',
    })
  })
})
