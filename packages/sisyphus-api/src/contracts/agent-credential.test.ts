import { describe, expect, it } from 'vitest'

import {
  AGENT_CREDENTIAL_MATERIAL_FIELD,
  agentCredentialFence,
  agentCredentialReference,
  credentialRotationRejection,
  fetchAgentCredentialInput,
  fetchAgentCredentialOutput,
  reportCredentialRotationInput,
  reportCredentialRotationOutput,
} from './agent-credential'

const CREDENTIAL_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const OTHER_CREDENTIAL_ID = '01890a5d-ac96-774b-bcce-b302099a8058'
const WORKFLOW_ID = '01890a5d-ac96-774b-bcce-b302099a8059'

/** Everything a caller might reach for if it wanted a seat other than its own. */
const NAMING_KEYS = [
  'credentialId',
  'agentCredentialId',
  'credential_id',
  'workflowId',
  'leaseId',
  'secretId',
  'name',
]

describe('fetchAgentCredentialInput', () => {
  it('has no parameter at all — the seat is the one the live lease names', () => {
    // Property one, asserted on the schema rather than trusted to the resolver: a caller cannot
    // ask for somebody else's credential because there is nowhere in the payload to write the
    // request. If this ever fails, read the module doc before "fixing" it.
    expect(Object.keys(fetchAgentCredentialInput.shape)).toStrictEqual([])
    expect(fetchAgentCredentialInput.parse({})).toStrictEqual({})
  })

  it('rejects every key by which a caller could name a seat, rather than stripping it', () => {
    for (const key of NAMING_KEYS) {
      expect(fetchAgentCredentialInput.safeParse({ [key]: OTHER_CREDENTIAL_ID }).success).toBe(
        false,
      )
    }
  })
})

describe('reportCredentialRotationInput', () => {
  const rotation = { fence: 4, material: '{"token":"abc"}' }

  it('names a fence and a payload, and nothing that could select a credential', () => {
    expect(Object.keys(reportCredentialRotationInput.shape)).toStrictEqual(['fence', 'material'])
    expect(reportCredentialRotationInput.parse(rotation)).toStrictEqual(rotation)
  })

  it('rejects every naming key, so the fence cannot be joined by a selector', () => {
    // The fence is a claim being presented for checking, not a way of reaching another row. That
    // only stays true while nothing sits beside it that could redirect the write.
    for (const key of NAMING_KEYS) {
      expect(
        reportCredentialRotationInput.safeParse({ ...rotation, [key]: OTHER_CREDENTIAL_ID })
          .success,
      ).toBe(false)
    }
  })

  it('preserves the material byte for byte, because trimming would rewrite a secret', () => {
    // `nonEmptyText` trims. The value here is the exact bytes read off the agent's credential
    // file, trailing newline included, and installing something that differs from what was
    // captured is a broken login nobody can explain.
    const withNewline = '{"token":"abc"}\n'

    expect(reportCredentialRotationInput.parse({ fence: 0, material: withNewline }).material).toBe(
      withNewline,
    )
  })

  it('refuses an empty rotation — a truncated write must not overwrite a working credential', () => {
    expect(reportCredentialRotationInput.safeParse({ fence: 0, material: '' }).success).toBe(false)
  })
})

describe('the material-bearing shapes', () => {
  it('are exactly the two that travel between the instance and the machine surface', () => {
    expect(Object.keys(fetchAgentCredentialOutput.shape)).toContain(AGENT_CREDENTIAL_MATERIAL_FIELD)
    expect(Object.keys(reportCredentialRotationInput.shape)).toContain(
      AGENT_CREDENTIAL_MATERIAL_FIELD,
    )
  })

  it('do not include anything that travels toward the panel or into the job envelope', () => {
    // Property two. The envelope becomes EC2 user-data, readable from the instance metadata
    // service by anything on the box (FR-012), and a panel response is a browser's memory.
    const identifierOnly = [
      agentCredentialReference,
      fetchAgentCredentialInput,
      ...reportCredentialRotationOutput.options,
    ]

    for (const schema of identifierOnly) {
      expect(Object.keys(schema.shape)).not.toContain(AGENT_CREDENTIAL_MATERIAL_FIELD)
    }
  })
})

describe('agentCredentialReference', () => {
  const reference = { credentialId: CREDENTIAL_ID, leaseFence: 7 }

  it('is the identifiers the envelope carries, and only those', () => {
    expect(agentCredentialReference.parse(reference)).toStrictEqual(reference)
    expect(Object.keys(agentCredentialReference.shape)).toStrictEqual([
      'credentialId',
      'leaseFence',
    ])
  })

  it('refuses material even when a caller supplies it explicitly', () => {
    expect(
      agentCredentialReference.safeParse({ ...reference, material: '{"token":"abc"}' }).success,
    ).toBe(false)
  })

  it('requires a real identifier rather than any string', () => {
    expect(
      agentCredentialReference.safeParse({ ...reference, credentialId: 'seat-1' }).success,
    ).toBe(false)
  })
})

describe('agentCredentialFence', () => {
  it('accepts zero — the value a credential has before it has ever been leased', () => {
    expect(agentCredentialFence.parse(0)).toBe(0)
  })

  it('rejects a value below zero, which no acquisition can produce', () => {
    expect(agentCredentialFence.safeParse(-1).success).toBe(false)
  })

  it('rejects a fractional or non-numeric fence — this counts acquisitions', () => {
    expect(agentCredentialFence.safeParse(1.5).success).toBe(false)
    expect(agentCredentialFence.safeParse('4').success).toBe(false)
  })

  it('carries a bigint column as a safe integer, because the envelope is JSON', () => {
    // `JSON.stringify` throws on a `bigint`, and `agentCredentialReference` is serialised into EC2
    // user-data. This is the assertion that stops the wire type drifting to one the transport
    // cannot carry.
    expect(agentCredentialFence.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true)
    expect(agentCredentialFence.safeParse(BigInt(4)).success).toBe(false)
    expect(() =>
      JSON.stringify(
        agentCredentialReference.parse({ credentialId: CREDENTIAL_ID, leaseFence: 7 }),
      ),
    ).not.toThrow()
  })
})

describe('reportCredentialRotationOutput', () => {
  it('gives a stale fence a representation of its own (FR-020)', () => {
    const stale = reportCredentialRotationOutput.parse({ accepted: false, reason: 'stale_fence' })

    expect(stale).toStrictEqual({ accepted: false, reason: 'stale_fence' })
    // Distinguishable from the other rejection and from acceptance, which is the whole point: a
    // `stale_fence` holder has lost its seat and should stop, a `not_newer` holder should carry on.
    expect(stale).not.toStrictEqual(
      reportCredentialRotationOutput.parse({ accepted: false, reason: 'not_newer' }),
    )
    expect(stale).not.toStrictEqual(reportCredentialRotationOutput.parse({ accepted: true }))
  })

  it('makes a reasonless rejection unrepresentable', () => {
    // The design note writes `reason?`. An optional reason permits a bare `{ accepted: false }`,
    // and a bare `false` is precisely the answer that collapses the two rejections into one.
    expect(reportCredentialRotationOutput.safeParse({ accepted: false }).success).toBe(false)
  })

  it('makes an acceptance carrying a rejection reason unrepresentable', () => {
    expect(
      reportCredentialRotationOutput.safeParse({ accepted: true, reason: 'stale_fence' }).success,
    ).toBe(false)
  })

  it('rejects a reason outside the closed vocabulary', () => {
    expect(
      reportCredentialRotationOutput.safeParse({ accepted: false, reason: 'expired' }).success,
    ).toBe(false)
    expect(credentialRotationRejection.options).toStrictEqual(['stale_fence', 'not_newer'])
  })

  it('says nothing about the run, so a post-terminal rotation is representable (FR-032)', () => {
    // Acceptance depends on the fence being current and on nothing else. A shape that referred to
    // workflow state would make FR-032 a resolver's promise rather than a property of the wire.
    for (const option of reportCredentialRotationOutput.options) {
      expect(Object.keys(option.shape)).not.toContain('workflowId')
      expect(Object.keys(option.shape)).not.toContain('state')
    }

    expect(reportCredentialRotationOutput.parse({ accepted: true })).toStrictEqual({
      accepted: true,
    })
  })
})

describe('fetchAgentCredentialOutput', () => {
  it('carries the material with the two identifiers the instance reports back under', () => {
    const answer = { credentialId: CREDENTIAL_ID, fence: 3, material: '{"token":"abc"}' }

    expect(fetchAgentCredentialOutput.parse(answer)).toStrictEqual(answer)
  })

  it('names no workflow — the answer is about a seat, not about a run', () => {
    expect(
      fetchAgentCredentialOutput.safeParse({
        credentialId: CREDENTIAL_ID,
        fence: 3,
        material: '{"token":"abc"}',
        workflowId: WORKFLOW_ID,
      }).success,
    ).toBe(false)
  })
})
