/**
 * The control plane's AWS layer — five narrow interfaces and their adapters (T054).
 *
 * Each seam states what the control plane *does* with a service, not what the service offers:
 * compute is launch/terminate/list, storage is head/list/remove, parameters are write/read/remove,
 * schedules are upsert/remove/list and a secret is read. Thirteen methods in total, against five
 * SDKs that expose several hundred — which is the point. A seam the width of the SDK is a
 * re-export, and the control plane would be untestable without provisioning real compute.
 *
 * Every interface ships with a recording fake in this directory, exported here so other jobs'
 * tests take the same one rather than inventing a stub apiece. **No module in this directory
 * constructs a client**: adapters are handed one, so importing the barrel reaches no account.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export { createEc2ComputeProvisioner, NAME_TAG, WORKFLOW_ID_TAG } from './compute'
export type {
  ComputeProvisioner,
  Ec2CommandSender,
  Ec2ComputeConfiguration,
  Ec2ComputeProvisionerOptions,
  LaunchComputeRequest,
  LaunchedCompute,
  WorkflowInstance,
} from './compute'

export { createFakeComputeProvisioner } from './compute-fake'
export type { FakeComputeProvisioner, FakeComputeProvisionerOptions } from './compute-fake'

export { createS3ObjectStore } from './object-store'
export type { ObjectStore, S3CommandSender, StoredObject } from './object-store'

export { createFakeObjectStore } from './object-store-fake'
export type { FakeObjectStore } from './object-store-fake'

export { createSsmParameterStore } from './parameter-store'
export type { ParameterStore, SsmCommandSender } from './parameter-store'

export { createFakeParameterStore } from './parameter-store-fake'
export type { FakeParameter, FakeParameterStore } from './parameter-store-fake'

export { createEventBridgeScheduleRegistry } from './schedules'
export type {
  ScheduleDefinition,
  ScheduleRegistry,
  SchedulerCommandSender,
  SchedulerConfiguration,
} from './schedules'

export { createFakeScheduleRegistry } from './schedules-fake'
export type { FakeScheduleRegistry } from './schedules-fake'

export { createSecretsManagerReader } from './secrets'
export type { SecretReader, SecretsCommandSender } from './secrets'

export { createFakeSecretReader } from './secrets-fake'
export type { FakeSecretReader } from './secrets-fake'
