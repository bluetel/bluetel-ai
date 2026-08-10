/**
 * The hosted login environment — provisioning it, relaying a terminal into it, capturing what it
 * produces, and destroying it whatever happens (T078, FR-069..FR-072, SC-001).
 *
 * ## The flow behind this barrel, in order
 *
 * 1. `admin.credentials.startLogin` calls {@link provisionLoginEnvironment}, which launches a
 *    **bundle-less, workspace-less** instance carrying the agent CLI and a wall-clock deadline
 *    (`environment.ts`).
 * 2. {@link createSsmLoginRelay} opens a Session Manager terminal into it and hands the handle
 *    back, so the administrator drives the **agent's own login** inside platform infrastructure
 *    (`relay.ts`).
 * 3. {@link captureLoginMaterial} polls the instance, reads the material the agent wrote **on the
 *    instance**, and stores it through the same `persistRotation` a rotation uses (`capture.ts`).
 * 4. {@link reapLoginEnvironments} destroys anything still standing past its deadline, on a
 *    schedule, whether or not anybody is watching (`reaper.ts`).
 *
 * ## Where the material is, at every step
 *
 * On the instance, then in one function's arguments inside the control plane, then in Secrets
 * Manager. **The panel is never one of those places.** The administrative surface's only port onto
 * this machinery is `AgentCredentialLoginEnvironments` in `@bluetel-ai/sisyphus-api/server`, and
 * not one field on any of its types can hold a value — so there is no response for material to
 * travel in, whatever a later contributor might want. What crosses to the browser is an instance
 * id, two timestamps and a Session Manager handle: a credential for a terminal, not for an agent.
 *
 * ## Why this is a subdirectory
 *
 * `../mint.ts` and `../revoke.ts` are 002's **workflow-scoped JWT** — a short-lived token the
 * platform issues so an executor can call the machine surface. Everything here is the **agent's own
 * login** with its model provider. Two unrelated concepts that share a word; see the note in
 * `../index.ts`. Nothing from this directory is re-exported from there, and consumers import this
 * barrel rather than a module underneath it.
 */

export {
  DEFAULT_LOGIN_TTL_MS,
  destroyLoginEnvironment,
  listLoginEnvironments,
  listUnattributedLoginEnvironments,
  LOGIN_INSTANCE_TYPE,
  LOGIN_MATERIAL_PATH,
  loginUserData,
  provisionLoginEnvironment,
} from './environment'
export type { LoginEnvironmentRecord, ProvisionLoginEnvironmentOptions } from './environment'

export { createSsmLoginRelay } from './relay'
export type { LoginRelay, RelayedSession, SsmSessionCommandSender } from './relay'

export { captureLoginMaterial, loginSecretName } from './capture'
export type { CaptureLoginMaterialOptions, CaptureOutcome, LoginMaterialSource } from './capture'

export {
  REAP_LOGIN_ENVIRONMENTS_JOB_NAME,
  reapingEnvironments,
  reapLoginEnvironments,
} from './reaper'
export type { ReapLoginEnvironmentsOptions, ReapLoginEnvironmentsResult } from './reaper'
