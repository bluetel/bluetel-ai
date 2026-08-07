/**
 * Type generation only. This config deploys nothing and needs no credentials.
 *
 * A fresh clone has no generated type tree, and without it the ambient `sst.*` /
 * `aws.*` globals every other config file uses are undeclared — so the clone
 * cannot typecheck, and the two configs that *could* generate the types both
 * refuse to run: the application config resolves a dozen values from the
 * parameter store before it can name the app, and the bootstrap config expects
 * the ambient credential chain. Neither precondition holds during
 * `pnpm install`. This file has no preconditions at all, which is the whole
 * point of it (FR-198, FR-199).
 *
 * ---------------------------------------------------------------------------
 * The provider block is the load-bearing part
 * ---------------------------------------------------------------------------
 * It must declare exactly the providers `sst.config.ts` declares, at exactly the
 * same pinned versions. The generated types describe the providers named here;
 * if they differ from the ones a deploy resolves, the code compiles against one
 * API and runs against another. Change one, change all four:
 * `sst.config.ts`, `sst-bootstrap.config.ts`, this file, and the matching pin in
 * `packages/sisyphus-infra/sst-install.config.ts`.
 *
 * `run()` is empty on purpose. This config must never be passed to `sst deploy`.
 */

export default $config({
  app: () => ({
    name: 'sisyphus-admin',
    home: 'aws',
    providers: { aws: { version: '6.66.2' } },
  }),

  run: () => Promise.resolve(),
})
