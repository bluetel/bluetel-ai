import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@sisyphus-admin/*` path in tsconfig.json. Without it a module that imports
      // through the alias type-checks and then fails to resolve under vitest, which would make the
      // alias usable only in files nothing tests.
      '@sisyphus-admin': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    // Vitest's 5s default is a poor bound for this app. Several suites `await import()` the auth
    // and route barrels *inside* the test body — deliberately, so each one gets a fresh module
    // registry under its own stubbed environment — and Vite has to process the whole `next-auth` +
    // `@auth/*` graph inlined above before the first assertion runs. That is ~5s of import on an
    // idle machine and more when `nx run-many` has three vitest processes competing for cores, so
    // the default made these suites fail on contention rather than on anything they assert.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        // `next` publishes no exports map, so its `next/server` specifier, which carries no file extension, cannot be
        // resolved by Node's ESM loader — which is what an externalised `next-auth` would be
        // resolved by. Processing it through Vite instead applies Vite's extension resolution, so
        // the auth barrel is importable in a test rather than only in the Next.js runtime.
        inline: [/next-auth/, /@auth\//],
      },
    },
  },
})
