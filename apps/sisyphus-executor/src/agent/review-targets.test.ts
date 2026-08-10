/**
 * T196 — establishing what a review run is reviewing.
 *
 * This is the step with the worst failure mode in the review path: findings posted on somebody
 * else's pull request are visible to the customer and cannot be taken back. So most of what is
 * asserted here is what the resolver refuses — a repository outside the workspace, a pull request
 * the host does not have, and an empty answer that could so easily have become "review whatever is
 * open".
 */

import { describe, expect, it } from 'vitest'

import type { AgentFrame, AgentResultFrame } from './adapter'
import { createFrameTap } from './frame-tap'
import { answerMarkers } from './proposal-block'
import { resolveReviewTargets, REVIEW_TARGETS_TAG } from './review-targets'
import type { ReviewTargetEntry } from './review-targets'

const NONCE = 'c0ffee11'

const ENTRIES: readonly ReviewTargetEntry[] = [
  { entryId: 'entry-api', repository: 'https://forge.example/acme/api.git' },
  { entryId: 'entry-web', repository: 'https://forge.example/acme/web.git' },
]

const blockFor = (value: unknown): string => {
  const { open, close } = answerMarkers(REVIEW_TARGETS_TAG, NONCE)

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
  readonly targets: Promise<unknown>
  readonly tap: ReturnType<typeof createFrameTap>
  readonly asked: { readonly repository: string; readonly pullRequestNumber: number }[]
  readonly sent: string[]
  readonly delivered: Promise<void>
}

const harnessFor = (
  options: {
    readonly settleMs?: number
    readonly readPullRequest?: (input: {
      readonly repository: string
      readonly pullRequestNumber: number
    }) => Promise<{ readonly number: number; readonly url: string }>
  } = {},
): Harness => {
  const tap = createFrameTap()
  const sent: string[] = []
  const asked: { repository: string; pullRequestNumber: number }[] = []
  let announce: () => void = () => undefined
  const delivered = new Promise<void>((resolveDelivered) => {
    announce = () => {
      setTimeout(resolveDelivered, 0)
    }
  })

  const targets = resolveReviewTargets({
    agent: {
      sendTurn: (body) => {
        sent.push(body)
        announce()

        return Promise.resolve({ acknowledged: true, latencyMs: 1 })
      },
    },
    frames: tap,
    entries: ENTRIES,
    readPullRequest:
      options.readPullRequest ??
      (async (input) => {
        asked.push({ ...input })

        return Promise.resolve({
          number: input.pullRequestNumber,
          url: `https://forge.example/pull/${String(input.pullRequestNumber)}`,
        })
      }),
    nonce: () => NONCE,
    settleMs: options.settleMs ?? 20,
    deadlineMs: 5_000,
  })

  return { targets, tap, asked, sent, delivered }
}

describe('resolveReviewTargets — the targets', () => {
  it('takes the repository from the workspace and the url from the host', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(blockFor({ targets: [{ entryId: 'entry-web', pullRequestNumber: 12 }] })),
    )

    await expect(harness.targets).resolves.toStrictEqual([
      {
        entryId: 'entry-web',
        // Never the agent's: the entry it named is looked up in the envelope's own list (FR-109).
        repository: 'https://forge.example/acme/web.git',
        pullRequestNumber: 12,
        // Never the agent's either: this is the link a reviewer follows.
        pullRequestUrl: 'https://forge.example/pull/12',
      },
    ])
    expect(harness.asked).toStrictEqual([
      { repository: 'https://forge.example/acme/web.git', pullRequestNumber: 12 },
    ])
  })

  it('resolves a set, so a multi-entry review reaches one verdict over all of it (FR-119)', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(
        blockFor({
          targets: [
            { entryId: 'entry-api', pullRequestNumber: 7 },
            { entryId: 'entry-web', pullRequestNumber: 12 },
          ],
        }),
      ),
    )

    await expect(harness.targets).resolves.toHaveLength(2)
  })

  it('shows the agent only this run’s entries', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(blockFor({ targets: [{ entryId: 'entry-api', pullRequestNumber: 7 }] })),
    )
    await harness.targets

    expect(harness.sent[0]).toContain('workspace entry entry-api')
    expect(harness.sent[0]).toContain('workspace entry entry-web')
  })
})

describe('resolveReviewTargets — what it refuses', () => {
  it('halts rather than reviewing a repository this run does not have', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(blockFor({ targets: [{ entryId: 'entry-billing', pullRequestNumber: 3 }] })),
    )

    const error = await harness.targets.catch((thrown: unknown) => thrown)

    expect(String(error)).toContain('which this run does not have')
    // And nothing was asked of the host: the refusal happens before any request goes out.
    expect(harness.asked).toStrictEqual([])
  })

  it('halts on an empty list rather than reviewing whatever is open', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(assistant(blockFor({ targets: [] })))

    const error = await harness.targets.catch((thrown: unknown) => thrown)

    expect(String(error)).toContain('names an empty list of targets')
    expect(String(error)).toContain('comment on somebody else’s work')
  })

  it('halts when the agent names no targets at all', async () => {
    const harness = harnessFor({ settleMs: 20 })

    await harness.delivered
    harness.tap.observe(assistant('The prompt does not name a pull request.'))
    harness.tap.observe(result())

    await expect(harness.targets).rejects.toThrow('review target block')
  })

  it('halts when the host does not have the pull request', async () => {
    const harness = harnessFor({
      readPullRequest: () => Promise.reject(new Error('the forge answered 404')),
    })

    await harness.delivered
    harness.tap.observe(
      assistant(blockFor({ targets: [{ entryId: 'entry-api', pullRequestNumber: 999 }] })),
    )

    await expect(harness.targets).rejects.toThrow('could not be read from the code host')
  })

  it('halts on a pull request number that is not a positive whole number', async () => {
    const harness = harnessFor()

    await harness.delivered
    harness.tap.observe(
      assistant(blockFor({ targets: [{ entryId: 'entry-api', pullRequestNumber: '7' }] })),
    )

    await expect(harness.targets).rejects.toThrow('not a positive whole number')
  })
})
