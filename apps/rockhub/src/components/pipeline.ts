/**
 * Pipeline — composes the per-mention `process` callback that the
 * Mention_Queue invokes for each dequeued Trigger_Mention.
 *
 * The pipeline guarantees:
 *   1. `eyesReactor.react(mention)` settles (success or logged failure)
 *      BEFORE `openclawSpawner.spawn(item)` is called.
 *   2. The spawner runs unconditionally — an Eyes_Reactor failure does
 *      not block or skip the spawn.
 *   3. Every log entry includes `mentionIdentity`, `repo`, `sourceType`
 *      structured fields (Req 11.6).
 */

import type pino from 'pino'

import type { EyesReactorInstance } from './eyes-reactor'
import type { QueuedMention } from './mention-queue'
import type { OpenclawSpawnerInstance } from './openclaw-spawner'

// ── Public Interfaces ──────────────────────────────────────────────

export interface PipelineDeps {
  eyesReactor: EyesReactorInstance
  openclawSpawner: OpenclawSpawnerInstance
  logger: pino.Logger
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Creates the per-mention `process` callback compatible with
 * `MentionQueueDeps.process`.
 *
 * The returned function:
 *   1. Awaits `eyesReactor.react(item.mention)` — settles on success
 *      or logged failure (the reactor never throws).
 *   2. Calls `openclawSpawner.spawn(item)` unconditionally after the
 *      reactor settles.
 *   3. Logs the pipeline outcome at `info` level with structured fields.
 */
export const createPipeline = (deps: PipelineDeps): ((item: QueuedMention) => Promise<void>) => {
  const { eyesReactor, openclawSpawner, logger } = deps
  const log = logger.child({ component: 'pipeline' })

  return async (item: QueuedMention): Promise<void> => {
    const { mention } = item
    const logCtx = {
      mentionIdentity: mention.identity,
      repo: mention.repoFullName,
      sourceType: mention.sourceType,
    }

    // Step 1: Eyes reaction — settles (success or logged failure).
    const eyesOutcome = await eyesReactor.react(mention)

    // Step 2: Spawn unconditionally after the reactor settles.
    const spawnOutcome = openclawSpawner.spawn(item)

    // Step 3: Log the pipeline outcome.
    log.info(
      {
        ...logCtx,
        eyesStatus: eyesOutcome.status,
        spawnStatus: spawnOutcome.status,
      },
      'Pipeline complete',
    )
  }
}
