import type { SisyphusDependencies, SisyphusSession } from '@bluetel-ai/sisyphus-api/server'
import {
  createNotificationStore,
  createWebApiSlackMessenger,
  createWorkflowNotifier,
} from '@bluetel-ai/sisyphus-notify'
import { env } from '@sisyphus-admin/env'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'
import { WebClient } from '@slack/web-api'

import { createAgentCredentialMaterialStore } from './credential-material'
import { createScopedCredentialResolver, joseCredentialVerifier } from './machine-credential'
import { recordDenial } from './record-denial'

/**
 * What `sisyphus-api` is handed at the **machine** mount (`/api/machine`).
 *
 * It is a different object from {@link import('./dependencies').createSisyphusDependencies}. Two of
 * the differences are the whole of FR-005 as this app expresses it; the third is the notifier, and
 * it is about FR-136 rather than about authorisation — see below.
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
 *
 * ## The notifier, and why it is supplied here rather than on the interactive mount
 *
 * `workflow_succeeded`, `workflow_capped`, `workflow_cancelled`, `workflow_needs_attention` and
 * `review_iteration_failed` are all set by **an executor reporting in** — `reportTerminal` and
 * `recordIteration` on the machine surface — so this is the mount that needs a way to announce
 * them. `sisyphus-api` emits through `SisyphusDependencies.notifier`, after the state transaction
 * has committed and never inside it, and treats an absent one as a silent no-op. Supplying it is
 * therefore the difference between a platform that records outcomes and one that tells anybody
 * about them (FR-136).
 *
 * What is supplied is `@bluetel-ai/sisyphus-notify`'s `WorkflowNotifier` — **not an adapter**. The
 * package declares `WorkflowEventEmitter` as a one-method port whose notice is a subset of this
 * one's and whose return it never reads, precisely so the object the control plane already builds
 * is assignable as-is. Both hosts consequently deliver through the same store, the same coalescing
 * window and the same Slack seam; there is one implementation of "who hears about this run".
 *
 * The Slack client and the panel URL are resolved exactly as the control plane's `src/context.ts`
 * resolves them — from the validated environment, in the composition root and nowhere else, so no
 * resolver in `sisyphus-api` is ever handed a way to reach Slack. `WebClient` opens no connection
 * when it is constructed, so a request that notifies nothing pays for nothing.
 *
 * ## The credential material store, and why it is on this mount and no other (003/FR-012)
 *
 * `machine.fetchAgentCredential` and `machine.reportCredentialRotation` are the only two procedures
 * in the platform that read or write agent credential material, and both are here. So the store is
 * supplied here, and **deliberately not** by `./dependencies.ts` — see the note there. That is the
 * same asymmetry as the two above, expressed against the same object: an executor presenting a
 * workflow-scoped credential can reach material, and a signed-in administrator on `/api/trpc`
 * cannot, because the mount they arrive at was never handed a way to.
 *
 * Unwired, `agentCredentialMaterialStore` falls back to a store that refuses in both directions —
 * so until this line existed, every instance reaching `credential_install` failed with "this
 * deployment has no agent credential material store configured", and no run could start.
 * `credential-material.ts` explains why the panel is the host that can supply one and why it is a
 * second Secrets Manager adapter rather than the control plane's.
 */
export const createMachineDependencies = (): SisyphusDependencies => ({
  db: getAuthDatabase(),
  resolveSession: resolveNoSession,
  // See below the object for why the material store is here and on no other mount.
  resolveMachineCredential: createScopedCredentialResolver({
    db: getAuthDatabase(),
    secret: env.SISYPHUS_MACHINE_CREDENTIAL_SECRET,
    jwtVerify: joseCredentialVerifier,
    recordDenial,
  }),
  recordDenial,
  notifier: createWorkflowNotifier({
    store: createNotificationStore({ db: getAuthDatabase() }),
    messenger: createWebApiSlackMessenger({ client: new WebClient(env.SISYPHUS_SLACK_BOT_TOKEN) }),
    panel: { baseUrl: env.SISYPHUS_PANEL_URL },
  }),
  agentCredentialMaterial: createAgentCredentialMaterialStore(env.AWS_REGION),
})
