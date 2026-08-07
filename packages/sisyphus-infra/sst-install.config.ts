/**
 * Type generation only. This package deploys nothing.
 *
 * `sisyphus-infra` instantiates `sst.aws.*` and `aws.*` directly, and those
 * globals are declared by the deployment tool's *generated* type tree — which
 * only exists once its providers have been installed. Without this file the
 * package cannot compile on a fresh clone, so `pnpm install` runs it: it
 * declares the providers, creates nothing, and needs no credentials (FR-198,
 * FR-199).
 *
 * The provider version is pinned, and pinned to the same version each
 * deployable's application config declares. A version that drifts from theirs
 * would generate types describing resources a deploy will not resolve.
 */

export default $config({
  app: () => ({
    name: 'sisyphus-infra',
    home: 'aws',
    // Must equal the `aws` provider version in every deployable's
    // `sst.config.ts`, `sst-bootstrap.config.ts` and `sst-install.config.ts`.
    providers: { aws: { version: '6.66.2' } },
  }),

  run: () => Promise.resolve(),
})
