import type { SisyphusDependencies } from '@bluetel-ai/sisyphus-api/server'
import { createRefusingLoginEnvironments } from '@bluetel-ai/sisyphus-api/server'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'

import { resolveNoMachineCredential } from './machine-credential'
import { recordDenial } from './record-denial'
import { resolveSisyphusSession } from './resolve-session'

/**
 * Everything `sisyphus-api` needs from the panel, assembled per request.
 *
 * The package reads no environment and imports no Auth.js: it declares four dependencies and the
 * host supplies them. This function is the panel's supply, and it is a **function** rather than a
 * module-level constant for the same reason `createAuthConfig` is — `next build` imports every
 * route module while collecting page data, so a constant here would open a database pool and
 * require `DATABASE_URL` at build time for a route nobody is calling.
 *
 * `getAuthDatabase()` is memoised inside `sisyphus-api`, so calling it per request reuses the one
 * pool a warm container already holds rather than opening another.
 *
 * ## What this mount deliberately does not supply, and why each absence is the right answer
 *
 * Three of the optional ports on `SisyphusDependencies` belong to the agent credential pool, and
 * the panel can honestly fill exactly one of them — on the *other* mount. The remaining two are
 * stated here rather than merely omitted, because "nobody wired it" and "this host must not wire
 * it" look identical in a composition root and are completely different facts.
 *
 * **`agentCredentialMaterial` — not here, on purpose.** It is supplied by
 * `./machine-dependencies.ts`, and putting it on this object as well would put credential material
 * one `await` away from a panel response body, reachable by every administrative procedure. FR-070
 * is a property of which object holds what, and this is the object that must not hold it.
 *
 * **`agentCredentialLogin` — refusing, and the refusal is wired rather than left to a default.**
 * A login environment is a bundle-less EC2 instance plus a Session Manager relay: it needs
 * `ec2:RunInstances`, `iam:PassRole` onto the executor's runner role, `ssm:StartSession`, and the
 * AMI, subnet, security-group and instance-profile configuration that only
 * `apps/sisyphus-control-plane` holds. That is the control plane's whole privileged identity, and
 * granting it to an internet-facing web tier in order to reach `credentials/login/environment.ts`
 * — which this application cannot import in any case — would be a far worse trade than the
 * capability is worth. So `startLogin` refuses, naming the deployment rather than pretending to
 * open a terminal that will never appear (003/FR-069). The consequence is stated plainly because
 * somebody has to act on it: **the hosted login cannot be completed from this deployment as it
 * stands**, and closing that needs either a seam by which the panel asks the control plane to
 * provision one, or the administrative surface mounted somewhere that already has the identity.
 *
 * **`agentCredentialLeases` — absent, and absent is not the same as refusing.** `releaseLease` is
 * pure SQL over this package's own tables, so the privilege argument above does not apply; what
 * stops it is that the implementation lives in `apps/sisyphus-control-plane/src/credentials/lease/`
 * and no application in this repository imports another. Copying the rule here is the one thing
 * that must not happen — "release does not repair" is a single conditional on which FR-033 and
 * SC-010 both turn, and a second copy is how a cooling-off seat gets handed to the next run.
 *
 * The key is therefore left **undefined** rather than set to `createRefusingLeaseReleases()`, and
 * the difference is a real one. `admin.credentials.forceRelease` checks for an absent port *before*
 * it touches anything and refuses there; a refusing implementation would be reached one step later,
 * after the run had already been resolved to `failed` — so wiring the polite-looking default would
 * end somebody's run and free no seat. See the ordering note in
 * `server/admin/credential-leases.ts`; `dependencies.test.ts` asserts the absence for that reason.
 */
export const createSisyphusDependencies = (): SisyphusDependencies => ({
  db: getAuthDatabase(),
  resolveSession: resolveSisyphusSession,
  resolveMachineCredential: resolveNoMachineCredential,
  recordDenial,
  agentCredentialLogin: createRefusingLoginEnvironments(),
})
