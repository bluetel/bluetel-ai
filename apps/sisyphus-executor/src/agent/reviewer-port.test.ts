/**
 * T196 — the reviewer port, driven without a token of paid inference.
 *
 * The happy path matters less here than the refusals. A review is the one step whose wrong answer
 * merges unreviewed work, so what is asserted is that there is no route through this port that
 * produces a verdict the agent did not write: not from silence, not from a stream that ended, and
 * not from a block that says something the platform cannot record.
 */

import { describe, expect, it } from 'vitest'

import type { ReviewRequest, ReviewTarget } from '../workflows'

import type { AgentFrame, AgentResultFrame } from './adapter'
import { createFrameTap } from './frame-tap'
import { answerMarkers } from './proposal-block'
import { REVIEW_TAG } from './review-turn'
import { AgentReviewError, createAgentReviewerPort } from './reviewer-port'

const NONCE = 'b3ad-f33d'

const blockFor = (value: unknown): string => {
  const { open, close } = answerMarkers(REVIEW_TAG, NONCE)

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

const target: ReviewTarget = {
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  repository: 'acme/service',
  pullRequestNumber: 41,
  pullRequestUrl: 'https://forge.example/acme/service/pull/41',
}

const request: ReviewRequest = {
  skill: {
    skillName: 'sisyphus-review',
    entryId: target.entryId,
    resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
    absolutePath: '/workspace/primary/.claude/skills/sisyphus-review/SKILL.md',
    contentDigest: 'ab12cd34'.repeat(8),
    byteSize: 320,
    body: 'The client’s rubric.',
  },
  targets: [target],
}

interface Harness {
  readonly proposal: Promise<unknown>
  readonly tap: ReturnType<typeof createFrameTap>
  readonly sent: string[]
  readonly delivered: Promise<void>
}

const harnessFor = (options: { readonly settleMs?: number } = {}): Harness => {
  const tap = createFrameTap()
  const sent: string[] = []
  let announce: () => void = () => undefined
  const delivered = new Promise<void>((resolveDelivered) => {
    announce = () => {
      setTimeout(resolveDelivered, 0)
    }
  })

  const port = createAgentReviewerPort({
    agent: {
      sendTurn: (body) => {
        sent.push(body)
        announce()

        return Promise.resolve({ acknowledged: true, latencyMs: 1 })
      },
    },
    frames: tap,
    nonce: () => NONCE,
    settleMs: options.settleMs ?? 20,
    deadlineMs: 5_000,
  })

  return { proposal: port(request), tap, sent, delivered }
}

describe('createAgentReviewerPort — the verdict', () => {
  it('returns the verdict and findings the agent emitted', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(
        blockFor({
          verdict: 'fail',
          findings: [{ severity: 'blocker', summary: 'no migration', workflowEntryId: 'entry-a' }],
          comment: 'One blocker.',
        }),
      ),
    )

    await expect(harness.proposal).resolves.toStrictEqual({
      verdict: 'fail',
      findings: [{ severity: 'blocker', summary: 'no migration', workflowEntryId: 'entry-a' }],
      comment: 'One blocker.',
    })
  })

  it('writes one turn carrying the skill and this request’s markers', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(assistant(blockFor({ verdict: 'pass', findings: [] })))
    await harness.proposal

    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]).toContain('The client’s rubric.')
    expect(harness.sent[0]).toContain(answerMarkers(REVIEW_TAG, NONCE).open)
  })
})

describe('createAgentReviewerPort — no verdict is ever invented', () => {
  it('fails rather than passing when the agent goes quiet', async () => {
    const harness = harnessFor({ settleMs: 20 })

    await harness.delivered
    harness.tap.observe(assistant('I read the diff.'))
    harness.tap.observe(result())

    const error = await harness.proposal.catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentReviewError)
    expect(error).toMatchObject({ kind: 'no-answer' })
    expect(String(error)).toContain('merge unreviewed work')
  })

  it('fails when the agent’s output ends first', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(assistant('starting'))
    harness.tap.close()

    await expect(harness.proposal).rejects.toMatchObject({ kind: 'stream-ended' })
  })

  it('reports empty for a well-formed block that reviews nothing', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(assistant(blockFor({})))

    await expect(harness.proposal).rejects.toMatchObject({ kind: 'empty' })
  })

  it('reports unusable, naming the problem, for a severity it cannot record', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(
        blockFor({ verdict: 'fail', findings: [{ severity: 'showstopper', summary: 'x' }] }),
      ),
    )

    const error = await harness.proposal.catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'unusable' })
    expect(String(error)).toContain('blocker filed as a note is a blocker lost')
  })
})
