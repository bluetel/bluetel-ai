/**
 * A stub agent process that speaks the same NDJSON protocol as the real CLI.
 *
 * Built for spike S1 (T011) and kept because T057 needs exactly this: an
 * integration test of the adapter against a real child process, over real
 * pipes, with no paid inference. Every behaviour the adapter has to cope with
 * is a configuration flag here rather than a fork of the file — a slow
 * multi-chunk response so a turn can be injected mid-request, an optional
 * echo of user turns (what `--replay-user-messages` gives us), and an optional
 * unfamiliar frame so defensive parsing is exercised rather than assumed.
 *
 * The frame vocabulary — `system`, `assistant`, `user`, `result`, and the
 * `session_id` / `num_turns` / `total_cost_usd` fields — was taken from the
 * shipped CLI binary's own strings, not invented. It is a faithful subset, not
 * a complete model: see SPIKE-FINDINGS.md for what that does and does not buy.
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export interface StubAgentConfig {
  readonly sessionId: string
  /** Assistant frames emitted per response. More chunks, wider injection window. */
  readonly chunkCount: number
  /** Delay before each chunk. The response is slow on purpose. */
  readonly chunkDelayMs: number
  /** Echo each user turn straight back, as `--replay-user-messages` does. */
  readonly replayUserMessages: boolean
  /** Emit one frame of an unfamiliar type, to exercise defensive parsing. */
  readonly emitUnknownFrame: boolean
  /** Charged per completed response, so `total_cost_usd` moves. */
  readonly spendPerTurnUsd: number
}

export const STUB_AGENT_DEFAULTS: StubAgentConfig = {
  sessionId: '00000000-0000-4000-8000-000000000000',
  chunkCount: 8,
  chunkDelayMs: 40,
  replayUserMessages: true,
  emitUnknownFrame: false,
  spendPerTurnUsd: 0.01,
}

/** Marker prefix on the frame that confirms a turn arrived mid-response. */
export const INJECTION_MARKER = 'injected:'

/** Marker prefix on chunks emitted after guidance landed in the same request. */
export const GUIDED_MARKER = 'guided:'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Pull the text out of a frame of the given type. Both content shapes the CLI
 * accepts are handled — a bare string, and a block list — because the adapter
 * will send one of them and a spike that only understands its own output
 * proves nothing.
 */
export const readFrameText = (frame: unknown, type: string): string | undefined => {
  if (!isRecord(frame) || frame['type'] !== type) {
    return undefined
  }

  const message = frame['message']

  if (!isRecord(message)) {
    return undefined
  }

  const content = message['content']

  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const texts = content
    .filter(isRecord)
    .filter((block) => block['type'] === 'text')
    .map((block) => block['text'])
    .filter((text): text is string => typeof text === 'string')

  return texts.length > 0 ? texts.join('') : undefined
}

/** The text of a user turn, or `undefined` if this is not a user frame. */
export const readUserTurnText = (frame: unknown): string | undefined => readFrameText(frame, 'user')

/** The text of an assistant frame, or `undefined` if this is not one. */
export const readAssistantText = (frame: unknown): string | undefined =>
  readFrameText(frame, 'assistant')

/** Build the user frame the harness and the adapter both write to stdin. */
export const userTurnFrame = (body: string): string =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: body }] },
  })

export const parseStubAgentConfig = (raw: string | undefined): StubAgentConfig => {
  if (raw === undefined || raw === '') {
    return STUB_AGENT_DEFAULTS
  }

  const parsed: unknown = JSON.parse(raw)

  if (!isRecord(parsed)) {
    return STUB_AGENT_DEFAULTS
  }

  const pickNumber = (key: string, fallback: number): number => {
    const value = parsed[key]

    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  const pickBoolean = (key: string, fallback: boolean): boolean => {
    const value = parsed[key]

    return typeof value === 'boolean' ? value : fallback
  }

  const sessionId = parsed['sessionId']

  return {
    sessionId: typeof sessionId === 'string' ? sessionId : STUB_AGENT_DEFAULTS.sessionId,
    chunkCount: pickNumber('chunkCount', STUB_AGENT_DEFAULTS.chunkCount),
    chunkDelayMs: pickNumber('chunkDelayMs', STUB_AGENT_DEFAULTS.chunkDelayMs),
    replayUserMessages: pickBoolean('replayUserMessages', STUB_AGENT_DEFAULTS.replayUserMessages),
    emitUnknownFrame: pickBoolean('emitUnknownFrame', STUB_AGENT_DEFAULTS.emitUnknownFrame),
    spendPerTurnUsd: pickNumber('spendPerTurnUsd', STUB_AGENT_DEFAULTS.spendPerTurnUsd),
  }
}

export interface StubAgentStreams {
  readonly input: Readable
  readonly output: Writable
}

/**
 * Run the stub until its input closes.
 *
 * The scheduling is the whole point. Lines are consumed on their own loop
 * while a response is in flight, so a turn written to stdin part-way through a
 * response is seen immediately: it is acknowledged in place, and every chunk
 * emitted after it carries the guidance. A turn arriving while nothing is in
 * flight starts a fresh response instead.
 */
export const runStubAgent = async (
  config: StubAgentConfig,
  streams: StubAgentStreams,
): Promise<void> => {
  const write = (frame: unknown): void => {
    streams.output.write(`${JSON.stringify(frame)}\n`)
  }

  const assistant = (text: string): void => {
    write({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      session_id: config.sessionId,
    })
  }

  write({ type: 'system', subtype: 'init', session_id: config.sessionId })

  if (config.emitUnknownFrame) {
    write({ type: 'stub_diagnostic', note: 'frame of an unfamiliar type' })
  }

  let turns = 0
  let spendUsd = 0
  let guidance: string[] = []
  let inFlight: Promise<void> | undefined

  const respond = async (body: string): Promise<void> => {
    guidance = []

    for (let index = 0; index < config.chunkCount; index += 1) {
      await delay(config.chunkDelayMs)

      const prefix = guidance.length > 0 ? `${GUIDED_MARKER}${guidance.join('|')} ` : ''

      assistant(`${prefix}chunk ${index} for ${body}`)
    }

    turns += 1
    spendUsd = Number((spendUsd + config.spendPerTurnUsd).toFixed(6))

    write({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: turns,
      total_cost_usd: spendUsd,
      session_id: config.sessionId,
    })
  }

  const lines = createInterface({ input: streams.input, crlfDelay: Infinity })

  for await (const line of lines) {
    if (line.trim() === '') {
      continue
    }

    let frame: unknown

    try {
      frame = JSON.parse(line)
    } catch {
      write({ type: 'system', subtype: 'error', note: 'input line did not parse' })
      continue
    }

    const body = readUserTurnText(frame)

    if (body === undefined) {
      continue
    }

    if (config.replayUserMessages) {
      write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: body }] },
        session_id: config.sessionId,
      })
    }

    if (inFlight === undefined) {
      const running = respond(body)

      inFlight = running

      void running.finally(() => {
        if (inFlight === running) {
          inFlight = undefined
        }
      })

      continue
    }

    guidance.push(body)
    assistant(`${INJECTION_MARKER}${body}`)
  }

  await inFlight
}
