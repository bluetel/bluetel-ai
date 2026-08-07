/**
 * The webhook ingress (T122, FR-017).
 *
 * `route.ts` is Next.js's entry point and is deliberately **not** re-exported: it is a route module,
 * reached by the framework rather than by an import, and exporting it would put a handler that
 * opens a database pool one import away from anything that took this barrel.
 */

export { handleDelivery, IDENTITY_FIELDS } from './handle-delivery'
export type { DeliveryOutcome, DeliverySink, HandleDeliveryOptions } from './handle-delivery'

export { createMemoryReplayStore } from './replay-guard'
export type { ReplayStore } from './replay-guard'

export {
  deriveIntegrationKey,
  KEY_ID_HEADER,
  REPLAY_WINDOW_MS,
  SIGNATURE_HEADER,
  SIGNATURE_VERSION,
  signDelivery,
  signedPayload,
  TIMESTAMP_HEADER,
  verifyDelivery,
} from './verify-signature'
export type {
  VerificationFailure,
  VerificationResult,
  VerifyDeliveryInput,
} from './verify-signature'
