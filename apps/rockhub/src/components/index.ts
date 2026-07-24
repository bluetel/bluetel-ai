// Public API barrel for Rockhub components.
//
// Components are added here as they are implemented (see tasks.md):
//   - auth
//   - repo-filter
//   - event-filter
//   - mention-queue
//   - eyes-reactor
//   - openclaw-spawner
//   - webhook-receiver
//   - startup-scanner

export { createAuth, type AuthConfig, type AuthInstance } from './auth'
export { createEventFilter, type EventFilterConfig, type EventFilterFn } from './event-filter'
export {
  createMentionQueue,
  type MentionQueueDeps,
  type MentionQueueInstance,
  type QueuedMention,
} from './mention-queue'
export {
  createEyesReactor,
  type EyesReactorDeps,
  type EyesReactorInstance,
  type EyesReactorOutcome,
} from './eyes-reactor'
export {
  createOpenclawSpawner,
  type OpenclawSpawnerConfig,
  type OpenclawSpawnerDeps,
  type OpenclawSpawnerInstance,
  type OpenclawSpawnOutcome,
} from './openclaw-spawner'
export {
  createOpenclawAgentRegistry,
  type OpenclawAgentRegistryConfig,
  type OpenclawAgentRegistryDeps,
  type OpenclawAgentRegistryInstance,
  type RegisteredAgent,
} from './openclaw-agent-registry'
export { createPipeline, type PipelineDeps } from './pipeline'
export { createRepoFilter, type RepoFilterConfig } from './repo-filter'
export {
  createStartupScanner,
  type StartupScannerDeps,
  type StartupScannerInstance,
} from './startup-scanner'
export {
  createTunnelManager,
  type TunnelManagerConfig,
  type TunnelManagerInstance,
} from './tunnel-manager'
export {
  createWebhookReceiver,
  type WebhookReceiverConfig,
  type WebhookReceiverDeps,
  type WebhookReceiverResult,
} from './webhook-receiver'
export {
  createWebhookUrlUpdater,
  type WebhookUrlUpdaterConfig,
  type WebhookUrlUpdaterDeps,
  type WebhookUrlUpdaterInstance,
} from './webhook-url-updater'
