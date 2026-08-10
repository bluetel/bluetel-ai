/**
 * The secret store, as the **machine surface** is allowed to see it — the seam material actually
 * moves through (FR-011, FR-012, FR-030, FR-032).
 *
 * ## Why this is a second port and not a method on the first
 *
 * `server/admin/credential-login.ts` already declares the administrative surface's whole
 * relationship with credential material, and its whole design is that a holder of it **cannot read
 * or write any**: it starts an environment, finds one, lists them and destroys one, and not one
 * field on any of its types can carry a value. That is not conservatism, it is FR-070 — every
 * procedure on the administrative surface holds that port, so a `read` on it would put credential
 * material one `await` away from a panel response body, in code nobody had to change to make it
 * happen.
 *
 * The machine surface is the opposite case and cannot be served by the same object. An instance
 * that has reached `credential_install` exists precisely to be handed material, and a rotation
 * exists precisely to write it. So the capability is declared **separately**, in the machine
 * directory, and given its own key on `SisyphusDependencies`. The two ports are then not two views
 * of one capability but two capabilities, and which one a module holds is decided by which file it
 * imports:
 *
 * | | `AgentCredentialLoginEnvironments` (admin) | {@link AgentCredentialMaterialStore} (here) |
 * | --- | --- | --- |
 * | declared in | `server/admin/` | `server/machine/` |
 * | can read material | **no** | yes |
 * | can write material | **no** | yes |
 * | reachable from | the panel's request path | an executor's scoped credential only |
 *
 * Giving the administrative port a way to reach material instead would have been one fewer
 * interface and would have destroyed the property that port exists for. Nothing in `server/admin/` imports this module, and nothing
 * here can be reached without a `machineProcedure` credential, so FR-070 stays a fact about which
 * objects exist rather than a rule about who remembers not to call a method.
 *
 * ## Why a port at all, again
 *
 * Same reason as the admin one and the other two seams on `SisyphusDependencies`: the real client
 * lives in `apps/sisyphus-control-plane/src/aws/secrets.ts`, and this package is a library that the
 * panel, the control plane and the executor all consume — a dependency from here onto an
 * application would invert the graph. Constructing a second Secrets Manager client inside this
 * package would avoid the cycle and cost more, because there would then be two answers to "which
 * account, which region, which credential does the platform read secrets with".
 *
 * The two methods are deliberately the same two the control plane's `SecretReader` already has, and
 * are named the same, so wiring the adapter is an assignment rather than an adaptation. `create` is
 * **not** among them: minting a secret is the login environment's act, performed where the material
 * already is, and a machine surface that could create one would file material under an identifier
 * nothing references while reporting success for it.
 */

/**
 * Read and write the material behind one secret identifier. Two methods, and no third.
 *
 * A wider interface — list, create, delete — would be a Secrets Manager client, and every
 * implementation would then have to satisfy parts of it no procedure in this package may call.
 *
 * Neither method may cache. A rotation is written by one process and read by the next boot, and a
 * cached read is how a fresh instance authenticates with material the provider has already
 * invalidated; the control plane's adapter documents the same rule from its own side.
 */
export interface AgentCredentialMaterialStore {
  /**
   * The material filed under this identifier.
   *
   * @param secretId - What `agent_credentials.secret_id` records. Never null by the time this is
   *   called: a credential with nowhere to fetch from is refused before the store is reached.
   * @throws If the identifier names nothing, or the store cannot be reached. Both are transport
   *   failures from the caller's point of view, and both must reach the executor as errors so its
   *   FR-047 backoff retries them — an absent value answered as an empty string would install a
   *   working credential's worth of nothing.
   */
  readonly read: (secretId: string) => Promise<string>
  /**
   * Replace the material filed under this identifier.
   *
   * @param secretId - As above.
   * @param material - The rotated credential, exactly as the agent wrote it.
   * @throws If the write did not land. Never absorbed into a rejection by the caller: the two
   *   rejections this feature has both mean "the write was refused on its merits", and reporting a
   *   store outage as one of them would drop a rotation while telling the instance it was expected.
   */
  readonly write: (secretId: string, material: string) => Promise<void>
}

/** The reason given when a deployment has wired no material store. */
export const MATERIAL_STORE_NOT_CONFIGURED_REASON =
  'this deployment has no agent credential material store configured, so credential material cannot be read or written'

/**
 * The store used when a deployment has wired none. It **refuses both directions**.
 *
 * Refusing rather than answering something harmless-looking, for the reason
 * `createRefusingLoginEnvironments` refuses to start a login: a store that answered a read with an empty
 * string would install an empty credential on a paid instance and surface as an agent that cannot
 * authenticate, minutes later and nowhere near the cause. A store that swallowed a write would be
 * worse still — the platform would report a rotation as persisted and lose it, which is exactly the
 * failure FR-030 and FR-032 exist to prevent.
 *
 * It rejects rather than returning a refusal object, unlike its admin counterpart, and the asymmetry
 * follows from what each answer is for. The administrative port's refusals are **answers an
 * administrator has to read**, so they are data or a worded rejection. These two are **actions**; there is no material to
 * return in place of material, and the only honest answer is a failure the executor's backoff can
 * retry once somebody has configured the deployment.
 */
export const createRefusingMaterialStore = (): AgentCredentialMaterialStore => ({
  read: () => Promise.reject(new Error(MATERIAL_STORE_NOT_CONFIGURED_REASON)),
  write: () => Promise.reject(new Error(MATERIAL_STORE_NOT_CONFIGURED_REASON)),
})

/**
 * The store this request is to use: whatever the deployment wired, or the refusing default.
 *
 * The machine router is declared rather than built by a factory — there is one machine surface and
 * it has no per-mount configuration — so the resolution has one source instead of the admin
 * router's two, and the `??` here is the whole of it. Keeping it in a named function rather than
 * inline in each resolver is what stops a later procedure reaching for
 * `ctx.dependencies.agentCredentialMaterial` directly and, finding it optional, quietly doing
 * nothing when it is absent.
 *
 * @param configured - `SisyphusDependencies.agentCredentialMaterial`, wired or not.
 */
export const agentCredentialMaterialStore = (
  configured: AgentCredentialMaterialStore | undefined,
): AgentCredentialMaterialStore => configured ?? createRefusingMaterialStore()
