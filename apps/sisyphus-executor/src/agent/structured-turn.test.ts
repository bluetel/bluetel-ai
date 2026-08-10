/**
 * T196 — the shared question-and-answer machinery, driven without a token of paid inference.
 *
 * `developer-port.test.ts` already exercises this through the one port that predates it, including
 * against a real stub agent process. What is asserted here is what that test cannot see now that
 * the mechanics are shared: that the **tag** keeps two questions apart, and that the endings are
 * reported in the vocabulary each caller asked for rather than in a fixed one.
 */

import { describe, expect, it } from 'vitest'

import { AgentAdapterError } from './adapter'
import type { AgentFrame, AgentResultFrame } from './adapter'
import { createFrameTap } from './frame-tap'
import { answerMarkers } from './proposal-block'
import { askAgentForBlock } from './structured-turn'
import type { AgentBlockAnswer } from './structured-turn'

const NONCE = 'a1b2c3d4'
const TAG = 'sisyphus-test-answer'

const blockFor = (value: unknown, tag = TAG, nonce = NONCE): string => {
  const { open, close } = answerMarkers(tag, nonce)

  return `${open}\n${JSON.stringify(value)}\n${close}`
}

const assistant = (text: string): AgentFrame => ({ type: 'assistant', text })

const result = (over: Partial<AgentResultFrame> = {}): AgentFrame => ({
  type: 'result',
  subtype: 'success',
  isError: false,
  usage: { turns: 1, spendUsd: 0.01 },
  ...over,
})

interface Harness {
  readonly answer: Promise<AgentBlockAnswer>
  readonly tap: ReturnType<typeof createFrameTap>
  readonly sent: string[]
  readonly delivered: Promise<void>
}

const ask = (
  options: {
    readonly tag?: string
    readonly settleMs?: number
    readonly deadlineMs?: number
    readonly answerNoun?: string
    readonly sendTurn?: () => Promise<never>
  } = {},
): Harness => {
  const tap = createFrameTap()
  const sent: string[] = []
  let announce: () => void = () => undefined
  // Resolved on a macrotask, so a test never races the implementation's own bookkeeping.
  const delivered = new Promise<void>((resolveDelivered) => {
    announce = () => {
      setTimeout(resolveDelivered, 0)
    }
  })

  const answer = askAgentForBlock({
    agent: {
      sendTurn:
        options.sendTurn ??
        ((body: string) => {
          sent.push(body)
          announce()

          return Promise.resolve({ acknowledged: true, latencyMs: 1 })
        }),
    },
    frames: tap,
    tag: options.tag ?? TAG,
    nonce: NONCE,
    body: 'the question',
    answerNoun: options.answerNoun ?? 'test block',
    settleMs: options.settleMs ?? 20,
    deadlineMs: options.deadlineMs ?? 5_000,
  })

  return { answer, tap, sent, delivered }
}

describe('askAgentForBlock', () => {
  it('returns the object the agent emitted', async () => {
    const harness = ask()

    await harness.delivered
    harness.tap.observe(assistant(`thinking\n${blockFor({ verdict: 'pass' })}\n`))

    await expect(harness.answer).resolves.toEqual({
      kind: 'answered',
      value: { verdict: 'pass' },
    })
  })

  it('writes the body it was given and nothing else', async () => {
    const harness = ask()

    await harness.delivered
    harness.tap.observe(assistant(blockFor({ ok: true })))
    await harness.answer

    expect(harness.sent).toStrictEqual(['the question'])
  })

  it('is not answered by a block carrying a different tag', async () => {
    const harness = ask({ settleMs: 30 })

    await harness.delivered
    // The autonomous loop's shape: a development proposal is still in the conversation when the
    // reviewer is asked. Same nonce, different question — and it must not be read as this answer.
    harness.tap.observe(assistant(blockFor({ verdict: 'pass' }, 'sisyphus-some-other-question')))
    harness.tap.observe(result())

    await expect(harness.answer).resolves.toStrictEqual({
      kind: 'failed',
      failure: 'no-answer',
      detail: 'the agent reached a turn boundary and went quiet without a test block',
    })
  })

  it('describes the failure with the caller’s own noun', async () => {
    const harness = ask({ settleMs: 20, answerNoun: 'review block' })

    await harness.delivered
    harness.tap.observe(assistant('I had a look.'))
    harness.tap.observe(result())

    await expect(harness.answer).resolves.toMatchObject({
      failure: 'no-answer',
      detail: 'the agent reached a turn boundary and went quiet without a review block',
    })
  })

  it('reports stream-ended when the output stops first', async () => {
    const harness = ask()

    await harness.delivered
    harness.tap.observe(assistant('starting'))
    harness.tap.close()

    await expect(harness.answer).resolves.toMatchObject({ failure: 'stream-ended' })
  })

  it('reports agent-error and names the subtype', async () => {
    const harness = ask()

    await harness.delivered
    harness.tap.observe(result({ subtype: 'error_max_turns', isError: true }))

    const answer = await harness.answer

    expect(answer).toMatchObject({ failure: 'agent-error' })
    expect(answer.kind === 'failed' ? answer.detail : '').toContain('error_max_turns')
  })

  it('reports truncated when a block is opened and never closed', async () => {
    const harness = ask({ settleMs: 20 })

    await harness.delivered
    harness.tap.observe(assistant(`${answerMarkers(TAG, NONCE).open}\n{"verdict":`))
    harness.tap.observe(result())

    await expect(harness.answer).resolves.toMatchObject({ failure: 'truncated' })
  })

  it('reports malformed when a closed block is not JSON', async () => {
    const { open, close } = answerMarkers(TAG, NONCE)
    const harness = ask({ settleMs: 20 })

    await harness.delivered
    harness.tap.observe(assistant(`${open}\nI could not decide\n${close}`))
    harness.tap.observe(result())

    await expect(harness.answer).resolves.toMatchObject({ failure: 'malformed' })
  })

  it('reports timed-out when nothing arrives', async () => {
    const harness = ask({ deadlineMs: 30 })

    await expect(harness.answer).resolves.toMatchObject({ failure: 'timed-out' })
  })

  it('reports not-delivered when the turn cannot be written', async () => {
    const harness = ask({
      sendTurn: () =>
        Promise.reject(
          new AgentAdapterError('delivery-failed', 'the agent process is not accepting input'),
        ),
    })

    const answer = await harness.answer

    expect(answer).toMatchObject({ failure: 'not-delivered' })
    expect(answer.kind === 'failed' ? answer.detail : '').toContain('not accepting input')
  })

  it('keeps waiting when a boundary is followed by more output', async () => {
    const harness = ask({ settleMs: 40 })

    await harness.delivered
    harness.tap.observe(result())
    await new Promise((tick) => setTimeout(tick, 20))
    harness.tap.observe(assistant('still working'))
    await new Promise((tick) => setTimeout(tick, 40))
    harness.tap.observe(assistant(blockFor({ done: true })))

    await expect(harness.answer).resolves.toMatchObject({ kind: 'answered' })
  })
})
