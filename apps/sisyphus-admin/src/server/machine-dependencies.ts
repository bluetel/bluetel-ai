import type { SisyphusDependencies, SisyphusSession } from '@bluetel-ai/sisyphus-api/server'
import { env } from '@sisyphus-admin/env'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'

import { createScopedCredentialResolver, joseCredentialVerifier } from './machine-credential'
import { recordDenial } from './record-denial'

/**
 * What `sisyphus-api` is handed at the **machine** mount (`/api/machine`).
 *
 * It is a different object from {@link import('./dependencies').createSisyphusDependencies}, and
 * the two differences are the whole of FR-005 as this app expresses it:
 *
 * 1. `resolveMachineCredential` is the real verifier here and answers `null` on the interactive
 *    mount, so an executor credential presented at `/api/trpc` is never even inspected;
 * 2. `resolveSession` answers `null` here, so a **panel cookie presented to the machine surface
 *    signs nobody in**. `machineRouter` contains only `machineProcedure`, which reads
 *    `ctx.machineCredential()` and never `ctx.session` — but resolving a session anyway would put
 *    an Auth.js database round trip on the executor's hot path and would make the asymmetry a
 *    property of the router rather than of the mount.
 *
 * Called **per request**, like its interactive twin: `next build` imports every route module while
 * collecting page data, so a module-level constant here would open a pool and read the signing
 * secret at build time for a route nobody is calling.
 */

/**
 * The machine surface authenticates by credential, never by cookie.
 *
 * Zero-argument for the same reason `resolveSisyphusSession` is: a `Headers` parameter would
 * suggest something was read from it.
 */
export const resolveNoSession = (): Promise<SisyphusSession | null> => Promise.resolve(null)

/**
 * Assemble the machine mount's dependencies.
 *
 * The signing secret is read here rather than at module scope, and it is read from the validated
 * environment rather than `process.env`, so a missing `SISYPHUS_MACHINE_CREDENTIAL_SECRET` fails
 * naming itself at the first machine request instead of producing a verifier that silently refuses
 * every executor.
 *
 * The verifier itself is `@bluetel-ai/sisyphus-api/server`'s, shared with the control plane that
 * mints the credentials it accepts — there is one definition of what a valid credential is, not one
 * per host. All this mount supplies is the JOSE implementation and the denial recorder.
 *
 * `recordDenial` is passed here as well as being the dependency `machineProcedure` uses, and the
 * duplication is the point: the procedure can only record `machine_credential_missing`, because
 * `resolveMachineCredential` answers `MachineCredential | null` and a forged signature, a token
 * addressed to the interactive surface and an absent header are all `null` to it. Handing the
 * recorder to the verifier as well means the *precise* reason is recorded as
 * `machine_credential_invalid` alongside the coarse one, so an attempted forgery is
 * distinguishable from a torn-down credential in the trail.
 */
export const createMachineDependencies = (): SisyphusDependencies => ({
  db: getAuthDatabase(),
  resolveSession: resolveNoSession,
  resolveMachineCredential: createScopedCredentialResolver({
    db: getAuthDatabase(),
    secret: env.SISYPHUS_MACHINE_CREDENTIAL_SECRET,
    jwtVerify: joseCredentialVerifier,
    recordDenial,
  }),
  recordDenial,
})
