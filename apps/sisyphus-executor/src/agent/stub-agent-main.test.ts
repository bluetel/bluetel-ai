import { spawn } from 'node:child_process'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { resolveTsxBinary, stubAgentEntry } from './spike-stdin'
import { userTurnFrame } from './stub-agent'

/**
 * The entry point exists so the stub can be a genuine child process over
 * genuine pipes. This test spawns it exactly as the spike and T057 will, and
 * checks that its configuration argument survives the trip — a stub that
 * silently ignores its configuration would make every downstream assertion
 * about timing meaningless.
 */
const runEntry = async (
  config: Record<string, unknown>,
  turns: readonly string[],
): Promise<readonly string[]> => {
  const child = spawn(resolveTsxBinary(), [stubAgentEntry(), JSON.stringify(config)], {
    env: process.env,
  })

  const chunks: string[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'))
  })

  for (const turn of turns) {
    child.stdin.write(`${userTurnFrame(turn)}\n`)
  }

  child.stdin.end()

  const exitCode = await new Promise<number | null>((settle) => {
    child.once('close', settle)
  })

  expect(exitCode).toBe(0)

  return chunks
    .join('')
    .split('\n')
    .filter((line) => line !== '')
}

describe('stub-agent entry point', () => {
  it('runs as a child process and honours its configuration argument', async () => {
    const lines = await runEntry({ chunkCount: 2, chunkDelayMs: 5 }, ['a task'])

    const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    const assistantFrames = frames.filter((frame) => frame['type'] === 'assistant')

    expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(assistantFrames).toHaveLength(2)
    expect(frames.at(-1)).toMatchObject({ type: 'result', num_turns: 1 })
  }, 30_000)
})
