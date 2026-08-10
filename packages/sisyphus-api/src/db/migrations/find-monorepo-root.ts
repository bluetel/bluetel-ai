import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Walks up from `startDir` until it finds `pnpm-workspace.yaml`, the marker for this monorepo's
 * root.
 *
 * `deploy.ts` runs `sst tunnel` from `apps/sisyphus-admin` — the app that owns the shared VPC and
 * its bastion — even though it is itself part of `packages/sisyphus-api`. Walking up to a marker
 * survives being invoked from whatever working directory an nx target or a CI job happens to use;
 * a relative path counted in `../` segments breaks the moment either module moves.
 */
export const findMonorepoRoot = (startDir: string): string => {
  let current = path.resolve(startDir)

  for (;;) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(
        `Could not find the monorepo root (a "pnpm-workspace.yaml") above "${startDir}".`,
      )
    }
    current = parent
  }
}
