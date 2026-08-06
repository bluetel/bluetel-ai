/**
 * Spike S1 (T011) — NDJSON stdin turn injection.
 *
 * The question: can a user-turn frame written to a live agent process's stdin
 * **mid-request** reach the in-flight request, so a correction lands in the
 * same conversation without restarting the process (FR-044, FR-049)?
 *
 * This harness answers the mechanical half of that question against a stub
 * agent process (`stub-agent-main.ts`) that speaks the same NDJSON protocol.
 * It spawns a genuine child process over genuine pipes, starts a slow
 * response, waits until that response is demonstrably in flight, writes a
 * second user turn, and records three things: whether the turn was received
 * before the first `result` frame, whether the in-flight response changed as a
 * consequence, and whether the process survived it.
 *
 * What it deliberately does not do is invoke the real CLI, which would cost
 * the user money on every run and could not live in a test suite. See
 * SPIKE-FINDINGS.md for the exact boundary between what this observes, what
 * the CLI's own flags and shipped strings imply, and what stays unverified.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  GUIDED_MARKER,
  INJECTION_MARKER,
  readAssistantText,
  userTurnFrame,
  type StubAgentConfig,
} from './stub-agent'

const HERE = dirname(fileURLToPath(import.meta.url))

/** One frame as the harness saw it, with the time it arrived. */
export interface ObservedFrame {
  /** Position in arrival order, from zero. */
  readonly index: number
  /** Milliseconds since the child was spawned. */
  readonly atMs: number
  readonly type: string
  readonly text?: string
  readonly raw: string
}

export interface StdinInjectionOutcome {
  readonly childPid: number
  readonly frames: readonly ObservedFrame[]
  /** Assistant chunks seen before the second turn was written. */
  readonly chunksBeforeInjection: number
  /** Frame index where the agent confirmed the injected turn, or -1. */
  readonly injectionAcknowledgedAt: number
  /** Frame index of the first `result`, or -1 if the request never finished. */
  readonly firstResultAt: number
  /**
   * The claim under test: the injected turn was received while the first
   * request was still running, not after it completed.
   */
  readonly deliveredMidRequest: boolean
  /**
   * The stronger claim: output produced by the **same** in-flight request
   * changed after the injection, so the turn steered the request rather than
   * merely arriving during it.
   */
  readonly behaviourChangedMidRequest: boolean
  /** Chunks of the first response that carried the injected guidance. */
  readonly guidedChunkCount: number
  /** Write-to-acknowledgement latency for the injected turn, in milliseconds. */
  readonly injectionLatencyMs: number
  /** Number of `result` frames seen; one means a single uninterrupted request. */
  readonly resultFrameCount: number
  /** True if the child exited before the first request finished. */
  readonly exitedBeforeResult: boolean
  readonly exitCode: number | null
}

export interface StdinInjectionSpikeOptions {
  /** Chunks to wait for before injecting. Must be below `chunkCount`. */
  readonly injectAfterChunks?: number
  readonly stub?: Partial<StubAgentConfig>
  /** Overall deadline; the spike rejects rather than hanging a test run. */
  readonly timeoutMs?: number
}

/**
 * Locate the `tsx` runner by walking up from this file.
 *
 * Bare `node` cannot run the stub: the repository forbids `.js` suffixes on
 * local imports and Node's ESM resolver requires them, so the entry has to go
 * through a loader that resolves a specifier carrying no file suffix.
 */
export const resolveTsxBinary = (from: string = HERE): string => {
  let directory = resolve(from)

  for (;;) {
    const candidate = join(directory, 'node_modules', '.bin', 'tsx')

    if (existsSync(candidate)) {
      return candidate
    }

    const parent = dirname(directory)

    if (parent === directory) {
      throw new Error(
        'could not find node_modules/.bin/tsx above ' +
          from +
          ' — the spike needs it to run the stub agent as a child process',
      )
    }

    directory = parent
  }
}

/** Absolute path to the stub's child-process entry point. */
export const stubAgentEntry = (): string => join(HERE, 'stub-agent-main.ts')

interface Waiter {
  readonly predicate: (frame: ObservedFrame) => boolean
  readonly settle: (frame: ObservedFrame) => void
}

interface Collector {
  readonly frames: readonly ObservedFrame[]
  readonly waitFor: (
    predicate: (frame: ObservedFrame) => boolean,
    timeoutMs: number,
    description: string,
  ) => Promise<ObservedFrame>
}

const createCollector = (child: ChildProcessWithoutNullStreams, startedAt: number): Collector => {
  const frames: ObservedFrame[] = []
  const waiters = new Set<Waiter>()

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

  lines.on('line', (line: string) => {
    if (line.trim() === '') {
      return
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = undefined
    }

    const type =
      typeof parsed === 'object' && parsed !== null && 'type' in parsed
        ? String((parsed as { type: unknown }).type)
        : 'unknown'

    const frame: ObservedFrame = {
      index: frames.length,
      atMs: Date.now() - startedAt,
      type,
      text: readAssistantText(parsed),
      raw: line,
    }

    frames.push(frame)

    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.delete(waiter)
        waiter.settle(frame)
      }
    }
  })

  return {
    frames,
    waitFor: (predicate, timeoutMs, description) =>
      new Promise<ObservedFrame>((resolvePromise, rejectPromise) => {
        const existing = frames.find(predicate)

        if (existing !== undefined) {
          resolvePromise(existing)

          return
        }

        const timer = setTimeout(() => {
          waiters.delete(waiter)
          rejectPromise(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`))
        }, timeoutMs)

        const waiter: Waiter = {
          predicate,
          settle: (frame) => {
            clearTimeout(timer)
            resolvePromise(frame)
          },
        }

        waiters.add(waiter)
      }),
  }
}

const isChunk = (frame: ObservedFrame): boolean =>
  frame.type === 'assistant' && frame.text?.includes('chunk ') === true

/**
 * Run the spike once and report what was observed.
 *
 * Rejects if the injected turn is never acknowledged or the request never
 * completes — a spike that times out has to say so rather than return a
 * cheerful set of zeroes.
 */
export const runStdinInjectionSpike = async (
  options: StdinInjectionSpikeOptions = {},
): Promise<StdinInjectionOutcome> => {
  const injectAfterChunks = options.injectAfterChunks ?? 2
  const timeoutMs = options.timeoutMs ?? 15_000
  const stubConfig = { ...options.stub, chunkCount: options.stub?.chunkCount ?? 8 }

  const child = spawn(resolveTsxBinary(), [stubAgentEntry(), JSON.stringify(stubConfig)], {
    env: process.env,
  })

  const startedAt = Date.now()
  const collector = createCollector(child, startedAt)
  let closedAtMs: number | undefined
  const exited = new Promise<number | null>((resolvePromise) => {
    child.once('close', (code) => {
      closedAtMs = Date.now() - startedAt
      resolvePromise(code)
    })
  })

  try {
    await collector.waitFor((frame) => frame.type === 'system', timeoutMs, 'the session to start')

    child.stdin.write(`${userTurnFrame('first task')}\n`)

    // Wait until the response is demonstrably running. Injecting before this
    // point would prove nothing: there would be no in-flight request to reach.
    await collector.waitFor(
      (frame) => isChunk(frame) && collector.frames.filter(isChunk).length >= injectAfterChunks,
      timeoutMs,
      `${injectAfterChunks} chunks of the first response`,
    )

    const chunksBeforeInjection = collector.frames.filter(isChunk).length
    const injectedAt = Date.now()

    child.stdin.write(`${userTurnFrame('correction')}\n`)

    const acknowledgement = await collector.waitFor(
      (frame) => frame.text?.startsWith(INJECTION_MARKER) === true,
      timeoutMs,
      'the injected turn to be acknowledged',
    )

    const result = await collector.waitFor(
      (frame) => frame.type === 'result',
      timeoutMs,
      'the first request to finish',
    )

    const guidedChunkCount = collector.frames.filter(
      (frame) => frame.index < result.index && frame.text?.startsWith(GUIDED_MARKER) === true,
    ).length

    // Both sides of this subtraction are milliseconds since spawn, so the
    // difference is the write-to-acknowledgement latency for the injected turn.
    const injectionLatencyMs = acknowledgement.atMs - (injectedAt - startedAt)
    const exitedBeforeResult = closedAtMs !== undefined && closedAtMs <= result.atMs

    child.stdin.end()

    const exitCode = await exited

    return {
      childPid: child.pid ?? -1,
      frames: [...collector.frames],
      chunksBeforeInjection,
      injectionAcknowledgedAt: acknowledgement.index,
      firstResultAt: result.index,
      deliveredMidRequest: acknowledgement.index < result.index,
      behaviourChangedMidRequest: guidedChunkCount > 0,
      guidedChunkCount,
      injectionLatencyMs,
      resultFrameCount: collector.frames.filter((frame) => frame.type === 'result').length,
      exitedBeforeResult,
      exitCode,
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
}
