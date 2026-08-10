import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  attachCredentialGroupInput,
  createCredentialGroupInput,
  credentialWaitDetail,
  CREDENTIAL_WAIT_WAITING_ON,
  listCredentialGroupsInput,
  moveCredentialToGroupInput,
  renameCredentialGroupInput,
  reorderCredentialGroupsInput,
  setCredentialGroupEnabledInput,
} from './credential'

describe('createCredentialGroupInput', () => {
  it('accepts a name and an optional description', () => {
    expect(createCredentialGroupInput.parse({ name: 'vendor pool' })).toStrictEqual({
      name: 'vendor pool',
    })
  })

  it('trims the name and rejects one that is only whitespace', () => {
    expect(createCredentialGroupInput.parse({ name: '  vendor pool  ' }).name).toBe('vendor pool')
    expect(createCredentialGroupInput.safeParse({ name: '   ' }).success).toBe(false)
  })
})

describe('renameCredentialGroupInput', () => {
  it('distinguishes “leave the description alone” from “clear it”', () => {
    // `undefined` and `null` are different requests, and a schema that collapsed them would make
    // clearing a description unexpressible from the panel.
    const untouched = renameCredentialGroupInput.parse({
      credentialGroupId: randomUUID(),
      name: 'renamed',
    })
    const cleared = renameCredentialGroupInput.parse({
      credentialGroupId: randomUUID(),
      name: 'renamed',
      description: null,
    })

    expect(untouched.description).toBeUndefined()
    expect(cleared.description).toBeNull()
  })

  it('requires a name — renaming to nothing is not a rename', () => {
    expect(
      renameCredentialGroupInput.safeParse({ credentialGroupId: randomUUID(), name: '' }).success,
    ).toBe(false)
  })
})

describe('setCredentialGroupEnabledInput', () => {
  it('requires the flag explicitly, so a missing field cannot read as “disable”', () => {
    expect(
      setCredentialGroupEnabledInput.safeParse({ credentialGroupId: randomUUID() }).success,
    ).toBe(false)
  })
})

describe('listCredentialGroupsInput', () => {
  it('defaults to the live, unfiltered view', () => {
    expect(listCredentialGroupsInput.parse({})).toStrictEqual({
      enabledOnly: false,
      includeArchived: false,
      limit: 50,
    })
  })
})

describe('the attachment inputs', () => {
  it('names a profile and a group, both as identifiers', () => {
    const executionProfileId = randomUUID()
    const credentialGroupId = randomUUID()

    expect(
      attachCredentialGroupInput.parse({ executionProfileId, credentialGroupId }),
    ).toStrictEqual({ executionProfileId, credentialGroupId })
    expect(
      attachCredentialGroupInput.safeParse({ executionProfileId, credentialGroupId: 'group-1' })
        .success,
    ).toBe(false)
  })

  it('takes the whole order on a reorder rather than a delta', () => {
    // A delta is evaluated against the order the panel last saw; a full list is evaluated against
    // the order that is actually there, which is what lets the resolver refuse a stale shuffle.
    const parsed = reorderCredentialGroupsInput.parse({
      executionProfileId: randomUUID(),
      credentialGroupIds: [randomUUID(), randomUUID()],
    })

    expect(parsed.credentialGroupIds).toHaveLength(2)
  })

  it('rejects an empty order — detaching is its own procedure', () => {
    expect(
      reorderCredentialGroupsInput.safeParse({
        executionProfileId: randomUUID(),
        credentialGroupIds: [],
      }).success,
    ).toBe(false)
  })
})

describe('moveCredentialToGroupInput', () => {
  it('names exactly one destination group (FR-061)', () => {
    const parsed = moveCredentialToGroupInput.parse({
      agentCredentialId: randomUUID(),
      credentialGroupId: randomUUID(),
    })

    expect(Object.keys(parsed).sort()).toStrictEqual(['agentCredentialId', 'credentialGroupId'])
  })
})

describe('credentialWaitDetail', () => {
  /** What the control plane writes when a run enters `awaiting_credential`. */
  const detail = {
    waitingOn: CREDENTIAL_WAIT_WAITING_ON,
    kind: 'all_held',
    configurationFault: false,
    groups: [{ name: 'shared-seats', position: 1 }],
    summary: 'Every agent credential this run can reach is held by another run.',
    remedy: 'Wait for a run to finish, or register more credentials in these groups.',
  }

  it('parses what the control plane records, groups and all (FR-029)', () => {
    expect(credentialWaitDetail.parse(detail)).toStrictEqual(detail)
  })

  it('refuses a timeline entry that is not about an agent credential', () => {
    // The discriminator is the whole point: `queued` also means "waiting under the FR-040 ceiling",
    // and a reader that accepted one for the other would tell an engineer their run is waiting for
    // a credential when it is waiting for a machine.
    expect(credentialWaitDetail.safeParse({ ...detail, waitingOn: 'storage' }).success).toBe(false)
    expect(credentialWaitDetail.safeParse({ ceiling: 4, liveLeasesBefore: 1 }).success).toBe(false)
  })

  it('requires the fault flag, so a missing field cannot read as “this will drain”', () => {
    // The one field a reader branches on. Defaulting it would turn a configuration mistake into a
    // queue somebody is told to wait out, which is precisely the FR-029 failure.
    const withoutFlag = Object.fromEntries(
      Object.entries(detail).filter(([key]) => key !== 'configurationFault'),
    )
    expect(credentialWaitDetail.safeParse(withoutFlag).success).toBe(false)
  })
})

describe('the credential schemas as a whole', () => {
  it('offers no field through which credential material could be sent', () => {
    // FR-070: material is captured server-side and never transits the panel. The check is on the
    // shapes rather than on each resolver, because a field added here would be accepted by the
    // resolver automatically.
    const shapes = [
      createCredentialGroupInput,
      renameCredentialGroupInput,
      setCredentialGroupEnabledInput,
      moveCredentialToGroupInput,
      attachCredentialGroupInput,
      reorderCredentialGroupsInput,
      listCredentialGroupsInput,
    ]

    for (const shape of shapes) {
      for (const key of Object.keys(shape.shape)) {
        expect(key).not.toMatch(/secret|token|credentialValue|material|password/i)
      }
    }
  })
})
