// Public API barrel for Rockhub shared library primitives.
//
// Modules are added here as they are implemented (see tasks.md):
//   - types               (task 2.1)
//   - logger              (task 2.6)
//   - mention-identity    (task 2.2)
//   - synthesized-payload (task 2.4)

export { createLogger } from './logger'

export {
  composeIdentity,
  matchesBotMention,
  parseIdentity,
  sanitizeForFilename,
} from './mention-identity'

export { buildSynthesizedPayload } from './synthesized-payload'
export type { SynthesizedPayloadInputs } from './synthesized-payload'

export type {
  IssueAssignedPayload,
  IssueCommentPayload,
  IssuePayload,
  MentionIdentity,
  MentionIdentityComponents,
  OpenclawInvocation,
  PRPayload,
  PRReviewCommentPayload,
  PRReviewRequestedPayload,
  RawWebhookEvent,
  SourceType,
  SynthesizedPayload,
  TriggerMention,
  WebhookPayload,
} from './types'
