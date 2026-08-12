import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Resolving a whole flat config and constructing a TypeScript program per fixture is
    // slow by nature — this suite trades wall-clock for the guarantee that no rule has
    // silently stopped running.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
