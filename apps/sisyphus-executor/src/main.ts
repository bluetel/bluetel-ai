import process from 'node:process'

import { createShutdownRegistry } from './runtime'

/**
 * Executor entry point. Bootstrap phases, the agent adapter and report-back
 * land in later tasks; for now this wires the process signals to the one
 * shutdown path so nothing added later has to invent its own.
 */
const main = (): void => {
  const registry = createShutdownRegistry()

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void registry.shutdown({ source: signal }).then(({ errors }) => {
        process.exitCode = errors.length > 0 ? 1 : 0
      })
    })
  }
}

main()
