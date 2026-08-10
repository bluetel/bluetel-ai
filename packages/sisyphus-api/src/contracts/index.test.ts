import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  AGENT_CREDENTIAL_MATERIAL_FIELD,
  agentCredentialFence,
  agentCredentialReference,
  credentialRotationRejection,
  fetchAgentCredentialInput,
  fetchAgentCredentialOutput,
  reportCredentialRotationInput,
  reportCredentialRotationOutput,
} from './index'
import type {
  AgentCredentialReference,
  ExecutorProtocolVersion,
  FetchAgentCredentialInput,
  ProtocolMessage,
  ReportCredentialRotationInput,
  ReportCredentialRotationOutput,
} from './index'

describe('executor protocol contract', () => {
  it('pins the protocol version to a literal union, not a widened string', () => {
    expectTypeOf<ExecutorProtocolVersion>().toEqualTypeOf<'v1'>()
    expectTypeOf<ExecutorProtocolVersion>().not.toEqualTypeOf<string>()
  })

  it('requires every protocol message to declare its version', () => {
    expectTypeOf<ProtocolMessage>().toExtend<{ protocolVersion: ExecutorProtocolVersion }>()
    expectTypeOf<{ protocolVersion: 'v1' }>().toExtend<ProtocolMessage>()
  })
})

describe('the agent credential contract', () => {
  it('is reachable from the barrel, which is the only path consumers may take', () => {
    // Three members import `@bluetel-ai/sisyphus-api/contracts` and none of them may reach into
    // `./agent-credential` directly (Constitution Principle II). A schema left off this barrel is
    // a schema the executor cannot use without breaking that rule, so its absence is asserted here
    // rather than discovered by whoever writes the second consumer.
    for (const schema of [
      agentCredentialFence,
      agentCredentialReference,
      credentialRotationRejection,
      fetchAgentCredentialInput,
      fetchAgentCredentialOutput,
      reportCredentialRotationInput,
      reportCredentialRotationOutput,
    ]) {
      expect(typeof schema.parse).toBe('function')
    }

    expect(AGENT_CREDENTIAL_MATERIAL_FIELD).toBe('material')
  })

  it('carries its inferred types through the barrel too', () => {
    // Property one, at the type level: the fetch payload has no keys, so a caller cannot name a
    // seat even in a language that would let it try.
    expectTypeOf<keyof FetchAgentCredentialInput>().toEqualTypeOf<never>()
    expectTypeOf<AgentCredentialReference>().toEqualTypeOf<{
      credentialId: string
      leaseFence: number
    }>()
    expectTypeOf<ReportCredentialRotationInput>().toEqualTypeOf<{
      fence: number
      material: string
    }>()
    expectTypeOf<ReportCredentialRotationOutput>().toEqualTypeOf<
      { accepted: true } | { accepted: false; reason: 'stale_fence' | 'not_newer' }
    >()
  })

  it('still refuses a named seat when reached through the barrel', () => {
    // The same guarantee as `agent-credential.test.ts`, asserted on the re-exported object. A
    // barrel that widened or wrapped a schema on the way through would pass the reachability test
    // above and quietly lose the property that matters.
    expect(fetchAgentCredentialInput.safeParse({ credentialId: 'other' }).success).toBe(false)
    expect(Object.keys(fetchAgentCredentialOutput.shape)).toContain(AGENT_CREDENTIAL_MATERIAL_FIELD)
    expect(Object.keys(agentCredentialReference.shape)).not.toContain(
      AGENT_CREDENTIAL_MATERIAL_FIELD,
    )
  })
})
