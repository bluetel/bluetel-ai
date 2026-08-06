/**
 * Child-process entry point for the stub agent.
 *
 * Kept separate from `stub-agent.ts` so the behaviour stays importable and
 * unit-testable over in-memory streams, while the spike harness (T011) and the
 * adapter integration test (T057) can still spawn it as a genuine child
 * process. That distinction matters: injecting a turn into an in-memory stream
 * proves nothing about pipes, and pipes are the mechanism under test.
 *
 * Configuration arrives as a single JSON argument rather than through the
 * environment, mirroring how the executor itself takes its job envelope.
 */

import process from 'node:process'

import { parseStubAgentConfig, runStubAgent } from './stub-agent'

const main = async (): Promise<void> => {
  const config = parseStubAgentConfig(process.argv[2])

  await runStubAgent(config, { input: process.stdin, output: process.stdout })
}

main().catch((error: unknown) => {
  process.stderr.write(`stub-agent failed: ${String(error)}\n`)
  process.exitCode = 1
})
