/**
 * In-memory FIFO Mention_Queue with Processed_Set deduplication.
 *
 * The queue guarantees at-most-once processing per Mention_Identity
 * across the lifetime of the Rockhub process. The `offer` operation
 * performs an atomic check-and-insert (single-threaded JavaScript
 * event loop ordering: `Set.has → Set.add → array.push`) so concurrent
 * offers from the Webhook_Receiver and the Startup_Scanner cannot both
 * succeed on the same identity.
 *
 * The drain loop uses a recursive `setImmediate` chain to yield back
 * to the event loop between items, processing sequentially (concurrency 1).
 */

import type pino from 'pino'

import type { MentionIdentity, SynthesizedPayload, TriggerMention, WebhookPayload } from '../lib'

// ── Public Interfaces ──────────────────────────────────────────────

export interface MentionQueueDeps {
  logger: pino.Logger
  process: (item: QueuedMention) => Promise<void>
}

export interface QueuedMention {
  mention: TriggerMention
  payload: WebhookPayload | SynthesizedPayload
  eventName: string
  deliveryId: string
}

export interface MentionQueueInstance {
  /**
   * Offer a TriggerMention. Returns true if accepted (new identity),
   * false if dropped (identity already in Processed_Set).
   */
  offer: (item: QueuedMention) => boolean

  /** Returns true iff identity is already in the Processed_Set. */
  has: (identity: MentionIdentity) => boolean

  /** Returns the current queue depth (excluding in-flight). */
  size: () => number

  /** Returns a snapshot of the Processed_Set size. */
  processedCount: () => number

  /** Begin draining. Idempotent. */
  start: () => void

  /**
   * Stop accepting new offers. Drops anything still in the queue.
   * Returns once any in-flight processing settles.
   */
  drain: () => Promise<void>
}

// ── Factory ────────────────────────────────────────────────────────

export const createMentionQueue = (deps: MentionQueueDeps): MentionQueueInstance => {
  const { logger, process: processItem } = deps

  const processedSet = new Set<MentionIdentity>()
  const queue: QueuedMention[] = []

  let draining = false
  let started = false
  let inFlight: Promise<void> | null = null
  let inFlightResolve: (() => void) | null = null

  // ── Drain loop ─────────────────────────────────────────────────

  const tick = (): void => {
    if (draining || queue.length === 0) {
      return
    }

    const item = queue.shift()
    if (!item) return

    // Track in-flight processing so `drain()` can await it
    inFlight = new Promise<void>((resolve) => {
      inFlightResolve = resolve
    })

    const run = async (): Promise<void> => {
      try {
        await processItem(item)
      } catch (err) {
        logger.error(
          {
            mentionIdentity: item.mention.identity,
            repo: item.mention.repoFullName,
            sourceType: item.mention.sourceType,
            err,
          },
          'Error processing mention in queue drain loop',
        )
      } finally {
        inFlight = null
        if (inFlightResolve) {
          inFlightResolve()
          inFlightResolve = null
        }

        // Schedule next tick via setImmediate to yield to the event loop
        if (!draining && queue.length > 0) {
          setImmediate(tick)
        }
      }
    }

    void run()
  }

  // ── Public API ─────────────────────────────────────────────────

  const offer = (item: QueuedMention): boolean => {
    if (draining) {
      return false
    }

    const id = item.mention.identity

    if (processedSet.has(id)) {
      logger.debug(
        {
          mentionIdentity: id,
          repo: item.mention.repoFullName,
          sourceType: item.mention.sourceType,
        },
        'Mention dropped — already in Processed_Set',
      )
      return false
    }

    // Atomic check-and-insert (single-threaded event loop)
    processedSet.add(id)
    queue.push(item)

    // Kick the drain loop if already started and not currently processing
    if (started && inFlight === null) {
      setImmediate(tick)
    }

    return true
  }

  const has = (identity: MentionIdentity): boolean => processedSet.has(identity)

  const size = (): number => queue.length

  const processedCount = (): number => processedSet.size

  const start = (): void => {
    if (started) return
    started = true

    // If items were offered before start(), kick the drain loop
    if (queue.length > 0) {
      setImmediate(tick)
    }
  }

  const drain = async (): Promise<void> => {
    draining = true

    // Drop remaining queue items
    queue.length = 0

    // Await any in-flight processing
    if (inFlight) {
      await inFlight
    }
  }

  return {
    offer,
    has,
    size,
    processedCount,
    start,
    drain,
  }
}
