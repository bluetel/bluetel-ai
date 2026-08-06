import { integrations } from '@bluetel-ai/sisyphus-api/db'
import { env } from '@sisyphus-admin/env'
import { getAuthDatabase } from '@sisyphus-admin/lib/auth'
import { and, eq, sql } from 'drizzle-orm'

import type { DeliverySink } from './handle-delivery'
import { handleDelivery } from './handle-delivery'
import type { ReplayStore } from './replay-guard'
import { createMemoryReplayStore } from './replay-guard'

/**
 * `POST /api/webhook` — signed, replay-rejecting external event ingress (T122, FR-017).
 *
 * Outside tRPC because the payload shape is the provider's, not ours (api-surface.md → Webhook
 * ingress). The pipeline is in `handle-delivery.ts`; this module is the adapter and the composition
 * root for it.
 *
 * ## What this route reads, in order
 *
 * `await request.text()` — the body as **text**. It is never `request.json()`, and that is the
 * requirement rather than a style choice: `json()` parses, and parsing is executing on unverified
 * input. Verification happens on the text; the parse happens after, inside `handleDelivery`.
 *
 * ## Where the channel goes
 *
 * A verified delivery issues the same Postgres `NOTIFY` that `admin.integrations.runNow` does. The
 * panel holds no permission to provision (FR-035), so an external event cannot start a run either —
 * it can only tell the control plane that a board is worth looking at sooner. The tick that follows
 * is subject to the same ceilings, the same claim and the same run record as a scheduled one.
 *
 * ## Nothing is evaluated at module scope
 *
 * `next build` imports every route module while collecting page data, so the database handle and
 * the signing secret are both reached **inside** the handler, per request. A constant here would
 * make the build itself need a database and a secret.
 *
 * The replay store is the one exception, and it has to be: a per-instance seen-set that was rebuilt
 * every request would remember nothing. It holds only signatures, opens nothing, and is bounded by
 * the verification window.
 */

/** Kept across invocations in a warm container. See `replay-guard.ts` on what that does and does not buy. */
const replay: ReplayStore = createMemoryReplayStore()

/** The channel the control plane listens on. The same one `admin.integrations.runNow` uses. */
export const WEBHOOK_TICK_CHANNEL = 'sisyphus_integration_tick'

/**
 * Signal the control plane, for an integration that exists and is enabled.
 *
 * The existence check is **not** an authorisation check — the signature already established that —
 * it is what stops a delivery for a deleted or disabled board waking a tick that would do nothing.
 */
const createNotifySink = (): DeliverySink => ({
  notify: async (integrationId) => {
    const db = getAuthDatabase()

    const rows = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(eq(integrations.id, integrationId), eq(integrations.enabled, true)))
      .limit(1)

    if (rows.length === 0) {
      return false
    }

    await db.execute(sql`select pg_notify(${WEBHOOK_TICK_CHANNEL}, ${integrationId})`)

    return true
  },
})

/**
 * A key id that is not a uuid never reaches the database.
 *
 * Drizzle binds every value, so this is not about injection; it is that a uuid column rejects a
 * malformed value with a database error, and an error is a different response shape from a refusal.
 * Every refusal from this route should look the same from outside.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const POST = async (request: Request): Promise<Response> => {
  // Text, not json. See the note above.
  const rawBody = await request.text()

  const outcome = await handleDelivery({
    headers: request.headers,
    rawBody,
    deploymentSecret: env.SISYPHUS_WEBHOOK_SIGNING_SECRET,
    replay,
    sink: {
      notify: async (integrationId) =>
        UUID.test(integrationId) ? createNotifySink().notify(integrationId) : false,
    },
  })

  // The body carries the outcome and never the reason a *verification* failed: telling an unverified
  // caller whether their timestamp or their signature was wrong is an oracle for guessing the other.
  const body =
    outcome.status === 401
      ? { accepted: false }
      : { accepted: outcome.status === 202, result: outcome.result }

  return Response.json(body, { status: outcome.status })
}
