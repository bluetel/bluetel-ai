/**
 * T194 — the developer port, driven without a token of paid inference.
 *
 * Two levels, and both are hermetic. The failure modes are exercised against a hand-driven tap, so
 * a truncated block or a stream that ends mid-answer is produced exactly rather than provoked. The
 * happy path and the stream-ended path are then exercised end to end against the **stub agent
 * process** through the real `createCliStreamAdapter` — a genuine child process over genuine
 * pipes, with the answer arriving in chunks the way a real one would.
 *
 * How the stub is made to answer: it echoes the turn body back inside every chunk of its response
 * (`chunk N for <body>`), and the turn body quotes the skill verbatim. So a fake skill whose body
 * contains a proposal block is a fake agent that answers with one — no change to the stub, no
 * network, no `claude` binary needed on the machine. The nonce is injected so the test can write
 * that block by hand.
 */

import { describe, expect, it } from 'vitest'

import type { DevelopmentRequest } from '../workflows'

import type { AgentAdapter, AgentFrame, AgentResultFrame } from './adapter'
import { AgentAdapterError } from './adapter'
import { createCliStreamAdapter } from './cli-stream'
import { AgentProposalError, createAgentDeveloperPort } from './developer-port'
import { createFrameTap, observeAgentFrames } from './frame-tap'
import type { AgentProcessSpecFactory } from './invocation'
import { proposalMarkers } from './proposal-block'
import { resolveTsxBinary, stubAgentEntry } from './spike-stdin'
import type { StubAgentConfig } from './stub-agent'

const NONCE = 'd4e5f6a7'
const SESSION_ID = '5b2e4c1a-0000-4000-8000-0000000004e2'

const PROPOSAL = {
  conventions: {
    remote: 'origin',
    branchName: 'sisyphus/T-194-developer-port',
    baseBranch: 'integration-line',
    pullRequestTitle: 'T-194 developer port',
  },
  summary: {
    entries: [
      {
        repository: 'acme/service',
        changed: true,
        description: 'implemented the port',
        paths: ['src/agent/developer-port.ts'],
      },
    ],
    decisions: ['followed the skill’s branch rule'],
    assumptions: [],
    notDone: [],
    uncertainties: ['unsure whether the integration line is the right base'],
  },
  wasChanged: true,
}

const blockFor = (value: unknown, nonce = NONCE): string => {
  const { open, close } = proposalMarkers(nonce)

  return `${open}\n${JSON.stringify(value)}\n${close}`
}

const skillWithBody = (body: string): DevelopmentRequest['skill'] => ({
  skillName: 'sisyphus-dev',
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-dev/SKILL.md',
  contentDigest: 'ab12cd34'.repeat(8),
  byteSize: 400,
  body,
})

const requestFor = (body: string, ordinal = 1): DevelopmentRequest => ({
  ordinal,
  skill: skillWithBody(body),
  feedback: [],
})

const request = requestFor('Read the ticket and do the work.')

const assistant = (text: string): AgentFrame => ({ type: 'assistant', text })

const result = (over: Partial<AgentResultFrame> = {}): AgentFrame => ({
  type: 'result',
  subtype: 'success',
  isError: false,
  usage: { turns: 1, spendUsd: 0.02 },
  ...over,
})

interface Harness {
  readonly port: ReturnType<typeof createAgentDeveloperPort>
  readonly tap: ReturnType<typeof createFrameTap>
  readonly sent: string[]
  /** Resolves once the turn has been written, so a frame is never emitted too early. */
  readonly delivered: Promise<void>
}

const harnessFor = (
  options: {
    readonly settleMs?: number
    readonly deadlineMs?: number
    readonly sendTurn?: AgentAdapter['sendTurn']
  } = {},
): Harness => {
  const tap = createFrameTap()
  const sent: string[] = []
  let announce: () => void = () => undefined
  // Resolved on a macrotask rather than inline, so that by the time a test emits its first frame
  // the port has finished its own post-write bookkeeping. Without it the test would be racing the
  // implementation over microtask ordering, and would win about half the time.
  const delivered = new Promise<void>((resolveDelivered) => {
    announce = () => {
      setTimeout(resolveDelivered, 0)
    }
  })

  const port = createAgentDeveloperPort({
    agent: {
      sendTurn:
        options.sendTurn ??
        ((body) => {
          sent.push(body)
          announce()

          return Promise.resolve({ acknowledged: true, latencyMs: 1 })
        }),
    },
    frames: tap,
    nonce: () => NONCE,
    settleMs: options.settleMs ?? 20,
    deadlineMs: options.deadlineMs ?? 5_000,
  })

  return { port, tap, sent, delivered }
}

describe('createAgentDeveloperPort — the answer', () => {
  it('returns the proposal the agent emitted', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(`working\n${blockFor(PROPOSAL)}\n`))

    await expect(proposal).resolves.toEqual({
      conventions: PROPOSAL.conventions,
      summary: PROPOSAL.summary,
      wasChanged: true,
    })
  })

  it('reassembles a block that arrived across several frames', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)
    const whole = blockFor(PROPOSAL)

    await harness.delivered

    for (let at = 0; at < whole.length; at += 17) {
      harness.tap.observe(assistant(whole.slice(at, at + 17)))
    }

    await expect(proposal).resolves.toMatchObject({ conventions: PROPOSAL.conventions })
  })

  it('writes one turn carrying the skill and the request’s own markers', async () => {
    const harness = harnessFor()
    const proposal = harness.port(requestFor('Follow the ticket.', 2))

    await harness.delivered
    harness.tap.observe(assistant(blockFor(PROPOSAL)))
    await proposal

    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]).toContain('Follow the ticket.')
    expect(harness.sent[0]).toContain(proposalMarkers(NONCE).open)
  })

  it('ignores a block left over from an earlier pass', async () => {
    const harness = harnessFor({ settleMs: 30 })
    const proposal = harness.port(request)

    await harness.delivered
    // The autonomous loop's second pass: pass one's answer is still in the conversation.
    harness.tap.observe(assistant(blockFor(PROPOSAL, 'the-previous-pass')))
    harness.tap.observe(result())

    await expect(proposal).rejects.toMatchObject({ kind: 'no-proposal' })
  })

  it('is not answered by the echo of its own turn', async () => {
    const harness = harnessFor({ settleMs: 30 })
    const proposal = harness.port(request)

    await harness.delivered
    // `--replay-user-messages` echoes the turn back, and the turn contains the markers.
    harness.tap.observe({ type: 'user', text: harness.sent[0] ?? '' })
    harness.tap.observe(result())

    await expect(proposal).rejects.toMatchObject({ kind: 'no-proposal' })
  })
})

describe('createAgentDeveloperPort — the pass produced nothing', () => {
  it('reports no-proposal when a turn boundary is followed by silence', async () => {
    const harness = harnessFor({ settleMs: 20 })
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant('I had a look around.'))
    harness.tap.observe(result())

    const error = await proposal.catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentProposalError)
    expect(error).toMatchObject({ kind: 'no-proposal', ordinal: 1 })
    expect(String(error)).toContain('went quiet')
  })

  it('keeps waiting when a boundary is followed by more output', async () => {
    const harness = harnessFor({ settleMs: 40 })
    const proposal = harness.port(request)

    await harness.delivered

    // The scheduling S1 could not settle: this boundary may belong to the request that was
    // already running, and the agent is about to answer ours.
    harness.tap.observe(result())
    await new Promise((tick) => setTimeout(tick, 20))
    harness.tap.observe(assistant('now starting on the pass'))
    await new Promise((tick) => setTimeout(tick, 40))
    harness.tap.observe(assistant(blockFor(PROPOSAL)))

    await expect(proposal).resolves.toMatchObject({ conventions: PROPOSAL.conventions })
  })

  it('does not treat a boundary from before the turn as this pass ending', async () => {
    const tap = createFrameTap()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld
    })

    const port = createAgentDeveloperPort({
      agent: {
        sendTurn: async () => {
          // A boundary lands while the write is still in flight.
          tap.observe(result())
          await held

          return { acknowledged: true, latencyMs: 1 }
        },
      },
      frames: tap,
      nonce: () => NONCE,
      settleMs: 20,
      deadlineMs: 5_000,
    })

    const proposal = port(request)

    release()
    await new Promise((tick) => setTimeout(tick, 40))
    tap.observe(assistant(blockFor(PROPOSAL)))

    await expect(proposal).resolves.toMatchObject({ conventions: PROPOSAL.conventions })
  })

  it('reports stream-ended when the agent’s output stops before it answers', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant('starting'))
    harness.tap.close()

    await expect(proposal).rejects.toMatchObject({ kind: 'stream-ended' })
  })

  it('reports agent-error when the agent ends the turn with a failure', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(result({ subtype: 'error_max_turns', isError: true }))

    const error = await proposal.catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'agent-error' })
    expect(String(error)).toContain('error_max_turns')
  })

  it('reports timed-out when nothing arrives at all', async () => {
    const harness = harnessFor({ deadlineMs: 30 })
    const proposal = harness.port(request)

    await expect(proposal).rejects.toMatchObject({ kind: 'timed-out' })
  })

  it('reports not-delivered when the turn cannot be written', async () => {
    const harness = harnessFor({
      sendTurn: () =>
        Promise.reject(
          new AgentAdapterError('delivery-failed', 'the agent process is not accepting input'),
        ),
    })

    const error = await harness.port(request).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'not-delivered' })
    expect(String(error)).toContain('not accepting input')
  })

  it('names the pass, so a failure on the third iteration says so', async () => {
    const harness = harnessFor({ deadlineMs: 30 })

    const error = await harness.port(requestFor('again', 3)).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ ordinal: 3 })
    expect(String(error)).toContain('development pass 3')
  })
})

describe('createAgentDeveloperPort — the answer is not usable', () => {
  it('reports truncated when the stream ends mid-block', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(`${proposalMarkers(NONCE).open}\n{"conventions":`))
    harness.tap.close()

    const error = await proposal.catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'truncated' })
    expect(String(error)).toContain('never closed it')
  })

  it('reports truncated when a boundary arrives mid-block', async () => {
    const harness = harnessFor({ settleMs: 20 })
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(`${proposalMarkers(NONCE).open}\n{"conventions":`))
    harness.tap.observe(result())

    await expect(proposal).rejects.toMatchObject({ kind: 'truncated' })
  })

  it('reports malformed when the closed block does not contain JSON', async () => {
    const harness = harnessFor({ settleMs: 20 })
    const { open, close } = proposalMarkers(NONCE)
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(`${open}\nI could not work out the conventions\n${close}`))
    harness.tap.observe(result())

    await expect(proposal).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('waits past an unreadable block for a readable one', async () => {
    const harness = harnessFor({ settleMs: 200 })
    const { open, close } = proposalMarkers(NONCE)
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(`${open}\nthat did not come out right\n${close}`))
    harness.tap.observe(assistant(blockFor(PROPOSAL)))

    await expect(proposal).resolves.toMatchObject({ conventions: PROPOSAL.conventions })
  })

  it('reports empty when the block is well-formed and says nothing', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(blockFor({})))

    const error = await proposal.catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'empty' })
    expect(String(error)).toContain('none of the fields')
  })

  it('reports incomplete, naming each gap, and never fills one in', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(blockFor({ conventions: PROPOSAL.conventions })))

    const error = await proposal.catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ kind: 'incomplete' })
    expect(String(error)).toContain('no summary')
  })

  it('passes incomplete conventions through for FR-058 to halt on', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(
      assistant(
        blockFor({
          conventions: { remote: 'origin' },
          summary: PROPOSAL.summary,
        }),
      ),
    )

    // The bridge does not invent the missing three, and it does not raise its own error about
    // them either: `requireDeliveryConventions` halts naming sisyphus-dev and the step.
    await expect(proposal).resolves.toMatchObject({ conventions: { remote: 'origin' } })
  })

  it('leaves the conversation open for the next pass once it has an answer', async () => {
    const harness = harnessFor()
    const proposal = harness.port(request)

    await harness.delivered
    harness.tap.observe(assistant(blockFor(PROPOSAL)))
    await proposal

    // Neither the stream nor the tap is this port's to end: the autonomous loop sends two more
    // passes down the same conversation.
    expect(harness.tap.isClosed).toBe(false)
    expect(() => {
      harness.tap.observe(assistant('the next pass begins'))
    }).not.toThrow()
  })
})

const stubProcessSpec =
  (config: Partial<StubAgentConfig> = {}): AgentProcessSpecFactory =>
  () => ({
    command: resolveTsxBinary(),
    args: [stubAgentEntry(), JSON.stringify({ sessionId: SESSION_ID, ...config })],
    env: {},
  })

interface ProcessHarness {
  readonly adapter: AgentAdapter
  readonly tap: ReturnType<typeof createFrameTap>
  readonly logged: readonly AgentFrame[]
  readonly dispose: () => Promise<void>
}

/**
 * The adapter, the tap and the log pipeline in the arrangement the run uses: one consumer of
 * `output`, with the port watching what that consumer pulls.
 */
const processHarness = (config: Partial<StubAgentConfig> = {}): ProcessHarness => {
  const tap = createFrameTap()
  const adapter = observeAgentFrames(
    createCliStreamAdapter({
      processSpec: stubProcessSpec(config),
      onUnknownFrame: () => undefined,
    }),
    tap,
  )

  // The run's single consumer: `runExecutor` turns these into log segments.
  const logged: AgentFrame[] = []
  const pumping = (async (): Promise<void> => {
    for await (const frame of adapter.output) {
      logged.push(frame)
    }
  })()

  return {
    adapter,
    tap,
    logged,
    dispose: async (): Promise<void> => {
      await adapter.stop({ force: true, timeoutMs: 2_000 })
      await pumping
    },
  }
}

describe('createAgentDeveloperPort — against the stub agent process', () => {
  it('reads a proposal out of a real frame stream, chunked over real pipes', async () => {
    const harness = processHarness({ chunkCount: 3, chunkDelayMs: 10 })

    try {
      await harness.adapter.start({
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        model: 'claude-sonnet-4-5',
        prompt: 'the opening prompt from the envelope',
      })

      const port = createAgentDeveloperPort({
        agent: harness.adapter,
        frames: harness.tap,
        nonce: () => NONCE,
        settleMs: 2_000,
        deadlineMs: 20_000,
      })

      // The stub echoes the turn body into every chunk of its response, so a skill body carrying
      // the block is an agent that answers with it.
      const proposal = await port(requestFor(blockFor(PROPOSAL)))

      expect(proposal).toEqual({
        conventions: PROPOSAL.conventions,
        summary: PROPOSAL.summary,
        wasChanged: true,
      })

      // The log pipeline still saw everything: the port taps the stream, it does not take it.
      expect(harness.logged.some((frame) => frame.type === 'assistant')).toBe(true)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('reports stream-ended when the agent process goes away mid-pass', async () => {
    const harness = processHarness({ chunkCount: 200, chunkDelayMs: 50 })

    try {
      await harness.adapter.start({
        sessionId: SESSION_ID,
        cwd: process.cwd(),
        model: 'claude-sonnet-4-5',
        prompt: 'the opening prompt from the envelope',
      })

      const port = createAgentDeveloperPort({
        agent: harness.adapter,
        frames: harness.tap,
        nonce: () => NONCE,
        settleMs: 2_000,
        deadlineMs: 20_000,
      })

      const proposal = port(requestFor('a pass the agent will not survive'))

      // A killed process group is what an instance reclaimed mid-pass looks like from here.
      setTimeout(() => {
        void harness.adapter.stop({ force: true, timeoutMs: 2_000 })
      }, 200)

      await expect(proposal).rejects.toMatchObject({ kind: 'stream-ended' })
    } finally {
      await harness.dispose()
    }
  }, 30_000)
})
