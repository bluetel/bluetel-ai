'use client'

import { api } from '@sisyphus-admin/trpc'
import { useMemo } from 'react'

import { toIntegrationView } from './integration-view'
import type {
  IntegrationsClient,
  IntegrationSubmission,
  PromptPreviewView,
  ValidationView,
} from './integrations-client'

/**
 * The panel's port, wired to `admin.integrations` (T199).
 *
 * ## Why an adapter and not `api.admin.integrations` in the panel
 *
 * The port exists so the screen can be rendered with no provider, no query client and no network —
 * that is what lets `integration-card`, `integration-editor` and the rest be asserted on directly.
 * Keeping it means the one place that knows about tRPC is this file, and it is nine lines of
 * forwarding per procedure rather than a rewrite of the screen.
 *
 * ## Reads go through the query cache; writes invalidate it
 *
 * `list` is a `fetch` against the shared client, so it honours the console's 30-second default and
 * a remount does not re-read a list nothing has changed. Every mutation therefore **invalidates**
 * `list` before it resolves — the panel calls `client.list()` immediately afterwards, and without
 * the invalidation it would render the state from before the write it just made.
 *
 * `previewPrompt` opts out with `staleTime: 0`. It is an explicit "show me this now" against a
 * stored prompt intro that an edit may have just changed, so a cached render would be answering a
 * question about the previous configuration.
 *
 * ## The credential does not appear here, in either direction
 *
 * `create` and `update` carry `credentialSecretArn` **inward** — that is the write half of FR-098.
 * Nothing maps it back out, because nothing returns it: see `integration-view.ts`, where the
 * absence is a compile-time assertion rather than a redaction step this file could forget.
 */

/**
 * How many integrations the screen reads at once.
 *
 * Fifty, matching every other admin listing. The screen has no pager, so this is also the point at
 * which one would be needed — a deployment with more boards than this would silently see a prefix.
 */
export const INTEGRATION_LIST_LIMIT = 50

/**
 * How many ticks the history shows.
 *
 * Twenty, not fifty: the question FR-105 exists to answer — "is this board silently failing?" — is
 * answered by the most recent runs, and a longer page buries the recent ones under a scroll.
 */
export const INTEGRATION_RUN_LIMIT = 20

/**
 * The mapping list, copied rather than passed through.
 *
 * The port declares it `readonly` because nothing downstream of the editor may reorder it — the
 * order *is* the resolution rule (FR-130) — while Zod infers a mutable array from
 * `integrationMappingInput`. Copying is the honest reconciliation: a cast would tell `tsc` the
 * caller's array is safe to mutate, which is the one thing it is not.
 */
const toMappingsInput = (mappings: IntegrationSubmission['mappings']) =>
  mappings.map((mapping) => ({
    position: mapping.position,
    criteria: mapping.criteria,
    executionProfileId: mapping.executionProfileId,
    isDefault: mapping.isDefault,
  }))

export const useIntegrationsApiClient = (): IntegrationsClient => {
  const utils = api.useUtils()

  return useMemo<IntegrationsClient>(() => {
    const integrations = utils.admin.integrations

    /**
     * Mark the list stale, so the panel's follow-up read is a read.
     *
     * Awaited rather than fired off: the panel treats the mutation resolving as "this is done and
     * the next list is current", and resolving before the cache was told otherwise would make that
     * false for exactly the fetch that follows.
     */
    const invalidateList = async (): Promise<void> => {
      await integrations.list.invalidate()
    }

    return {
      list: async () => {
        const page = await integrations.list.fetch({
          enabledOnly: false,
          limit: INTEGRATION_LIST_LIMIT,
        })

        return page.items.map(toIntegrationView)
      },

      create: async (input) => {
        await utils.client.admin.integrations.create.mutate({
          ...input,
          mappings: toMappingsInput(input.mappings),
        })
        await invalidateList()
      },

      update: async (input) => {
        await utils.client.admin.integrations.update.mutate({
          ...input,
          mappings: toMappingsInput(input.mappings),
        })
        await invalidateList()
      },

      setEnabled: async (input) => {
        await utils.client.admin.integrations.setEnabled.mutate(input)
        await invalidateList()
      },

      /**
       * The connectivity check FR-097 requires before enable.
       *
       * `integrationId` is dropped from the answer: the caller supplied it, and the panel keys the
       * result by the card it came from rather than by a field in it.
       */
      validate: async (input): Promise<ValidationView> => {
        const result = await utils.client.admin.integrations.validate.mutate(input)

        return { ok: result.ok, checks: result.checks }
      },

      /**
       * Ask the control plane to tick now (FR-097).
       *
       * Resolves to nothing on purpose. The procedure answers "requested", not "ran" — it issues a
       * `NOTIFY` — so a return value here would invite the screen to report a result that has not
       * happened yet. The tick shows up where every other tick does: the run history (FR-105),
       * which the invalidated list re-reads.
       */
      runNow: async (input) => {
        await utils.client.admin.integrations.runNow.mutate(input)
        await invalidateList()
      },

      /**
       * `admin.integrations.delete`, named `remove` on the port.
       *
       * Renamed only to keep `delete` off an interface where it would have to be quoted at every
       * call site; the procedure it reaches is the router's own.
       */
      remove: async (input) => {
        await utils.client.admin.integrations.delete.mutate(input)
        await invalidateList()
      },

      /**
       * The run history (FR-105).
       *
       * `staleTime: 0`, because the reason to open it is to find out whether the board is answering
       * *now* — a cached page would be answering the question the admin is trying to check.
       */
      runs: async (input) => {
        const page = await integrations.runs.fetch(
          { integrationId: input.integrationId, limit: INTEGRATION_RUN_LIMIT },
          { staleTime: 0 },
        )

        return page.items.map((run) => ({
          id: run.id,
          trigger: run.trigger,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          examinedCount: run.examinedCount,
          matchedCount: run.matchedCount,
          startedCount: run.startedCount,
          skippedCount: run.skippedCount,
          error: run.error,
        }))
      },

      previewPrompt: async (input): Promise<PromptPreviewView> => {
        const preview = await integrations.previewPrompt.fetch(input, { staleTime: 0 })

        return {
          prompt: preview.prompt,
          truncated: preview.truncated,
          truncatedComments: preview.truncatedComments,
          resolvedProfileId: preview.resolvedProfileId,
          resolutionReason: preview.resolutionReason,
        }
      },
    }
  }, [utils])
}
