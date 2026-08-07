import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import {
  GUIDED_MARKER,
  INJECTION_MARKER,
  parseStubAgentConfig,
  readAssistantText,
  readUserTurnText,
  runStubAgent,
  STUB_AGENT_DEFAULTS,
  userTurnFrame,
  type StubAgentConfig,
} from './stub-agent'

const collect = (stream: PassThrough): { readonly lines: string[] } => {
  const lines: string[] = []
  let buffer = ''

  stream.on('data', (chunk: Buffer | string) => {
    buffer += String(chunk)

    const parts = buffer.split('\n')

    buffer = parts.pop() ?? ''
    lines.push(...parts.filter((line) => line !== ''))
  })

  return { lines }
}

const config = (overrides: Partial<StubAgentConfig> = {}): StubAgentConfig => ({
  ...STUB_AGENT_DEFAULTS,
  chunkCount: 3,
  chunkDelayMs: 5,
  ...overrides,
})

describe('readUserTurnText', () => {
  it('reads the block-list content shape', () => {
    expect(readUserTurnText(JSON.parse(userTurnFrame('hello')))).toBe('hello')
  })

  it('reads the bare-string content shape', () => {
    const frame = { type: 'user', message: { role: 'user', content: 'hello' } }

    expect(readUserTurnText(frame)).toBe('hello')
  })

  it('ignores frames that are not user turns', () => {
    expect(readUserTurnText({ type: 'assistant', message: { content: 'hi' } })).toBeUndefined()
    expect(readUserTurnText({ type: 'user' })).toBeUndefined()
    expect(readUserTurnText('not a frame')).toBeUndefined()
    expect(readUserTurnText(null)).toBeUndefined()
  })
})

describe('parseStubAgentConfig', () => {
  it('falls back to the defaults on missing or unusable input', () => {
    expect(parseStubAgentConfig(undefined)).toEqual(STUB_AGENT_DEFAULTS)
    expect(parseStubAgentConfig('')).toEqual(STUB_AGENT_DEFAULTS)
    expect(parseStubAgentConfig('"a string"')).toEqual(STUB_AGENT_DEFAULTS)
  })

  it('ignores fields of the wrong type rather than propagating them', () => {
    const parsed = parseStubAgentConfig(JSON.stringify({ chunkCount: 'lots', chunkDelayMs: 7 }))

    expect(parsed.chunkCount).toBe(STUB_AGENT_DEFAULTS.chunkCount)
    expect(parsed.chunkDelayMs).toBe(7)
  })
})

describe('runStubAgent', () => {
  it('opens with an init frame and closes each response with a result', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)

    const finished = runStubAgent(config(), { input, output })

    input.write(`${userTurnFrame('first task')}\n`)
    input.end()

    await finished

    const frames = collected.lines.map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(frames.at(-1)).toMatchObject({ type: 'result', subtype: 'success', num_turns: 1 })
  })

  it('acknowledges a turn that arrives while a response is in flight', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)

    const finished = runStubAgent(config({ chunkCount: 6, chunkDelayMs: 10 }), { input, output })

    input.write(`${userTurnFrame('first task')}\n`)

    // Part-way through the first response, not before it and not after it.
    await new Promise((settle) => setTimeout(settle, 25))
    input.write(`${userTurnFrame('correction')}\n`)

    await new Promise((settle) => setTimeout(settle, 120))
    input.end()

    await finished

    const texts = collected.lines
      .map((line) => readAssistantText(JSON.parse(line)))
      .filter((text): text is string => text !== undefined)

    const acknowledgementIndex = texts.findIndex((text) => text.startsWith(INJECTION_MARKER))
    const resultIndex = collected.lines.findIndex((line) => line.includes('"type":"result"'))

    expect(acknowledgementIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(texts.filter((text) => text.startsWith(GUIDED_MARKER)).length).toBeGreaterThan(0)
  })

  it('produces exactly one result for a response that was steered mid-flight', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)

    const finished = runStubAgent(config({ chunkCount: 5, chunkDelayMs: 10 }), { input, output })

    input.write(`${userTurnFrame('first task')}\n`)
    await new Promise((settle) => setTimeout(settle, 25))
    input.write(`${userTurnFrame('correction')}\n`)
    await new Promise((settle) => setTimeout(settle, 120))
    input.end()

    await finished

    const results = collected.lines.filter((line) => line.includes('"type":"result"'))

    // A correction that cost a restart would show up here as a second result.
    expect(results).toHaveLength(1)
  })

  it('echoes user turns only when replay is enabled', async () => {
    const withReplay = new PassThrough()
    const withReplayOut = new PassThrough()
    const replayed = collect(withReplayOut)
    const replayFinished = runStubAgent(config({ replayUserMessages: true }), {
      input: withReplay,
      output: withReplayOut,
    })

    withReplay.write(`${userTurnFrame('a task')}\n`)
    withReplay.end()
    await replayFinished

    const silent = new PassThrough()
    const silentOut = new PassThrough()
    const quiet = collect(silentOut)
    const silentFinished = runStubAgent(config({ replayUserMessages: false }), {
      input: silent,
      output: silentOut,
    })

    silent.write(`${userTurnFrame('a task')}\n`)
    silent.end()
    await silentFinished

    expect(replayed.lines.some((line) => line.includes('"type":"user"'))).toBe(true)
    expect(quiet.lines.some((line) => line.includes('"type":"user"'))).toBe(false)
  })

  it('survives an input line that does not parse', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)

    const finished = runStubAgent(config(), { input, output })

    input.write('{"type":"user","message":{"cont\n')
    input.write(`${userTurnFrame('a task')}\n`)
    input.end()

    await finished

    expect(collected.lines.some((line) => line.includes('"type":"result"'))).toBe(true)
  })

  it('emits a frame of an unfamiliar type on request, for defensive parsing', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const collected = collect(output)

    const finished = runStubAgent(config({ emitUnknownFrame: true }), { input, output })

    input.end()
    await finished

    expect(collected.lines.some((line) => line.includes('stub_diagnostic'))).toBe(true)
  })
})
