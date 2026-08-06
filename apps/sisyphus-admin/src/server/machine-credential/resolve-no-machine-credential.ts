import type { MachineCredential } from '@bluetel-ai/sisyphus-api/server'

/**
 * The `resolveMachineCredential` the **interactive** surface is built with.
 *
 * Always `null`, and that is the correct answer rather than a stub. `/api/trpc` mounts `appRouter`,
 * which contains no `machineProcedure` at all, so nothing reachable through that context ever
 * calls the resolver. Answering `null` also makes the FR-005 asymmetry explicit at the mount: a
 * request to the interactive surface carrying an executor credential is a request carrying nothing
 * the interactive surface will look at.
 *
 * Verification itself — the `SISYPHUS_MACHINE_CREDENTIAL_SECRET` check, the `jti` lookup and the
 * expiry of FR-037 — lives in `./verify` and is wired only by `/api/machine`. Two mounts with two
 * different resolvers is what makes the asymmetry structural: it is not a check the interactive
 * surface performs and could forget, it is a capability it does not have.
 */
export const resolveNoMachineCredential = (): Promise<MachineCredential | null> =>
  Promise.resolve(null)
