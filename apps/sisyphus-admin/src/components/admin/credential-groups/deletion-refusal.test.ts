import { describe, expect, it } from 'vitest'

import {
  classifyDeletionCondition,
  DELETION_ACTIONS,
  deletionConditionCode,
  describeDeletionRefusal,
  DISABLE_ALTERNATIVE,
  readDeletionConditions,
} from './deletion-refusal'

/**
 * The property under test is FR-066's whole point: **which** condition applies is preserved from the
 * router's message to the screen. A test that only checked "a refusal is shown" would pass against
 * the flattening this module exists to prevent.
 *
 * The messages below are the ones `credentialGroupNotDeletableError` actually builds — see
 * `packages/sisyphus-api/src/server/admin/credential-groups.ts` — so a change to its wording that
 * broke the classification would fail here rather than degrade silently in the browser.
 */

const refusal = (message: string) => ({ message, data: { code: 'CONFLICT' } })

const BOTH_CONDITIONS = [
  'The credential group Payments cannot be deleted:',
  '- it holds 4 agent credentials; move them to another group or archive them first',
  '- it is attached to the execution profiles Payments — delegated, Payments — review; detach it there first',
  DISABLE_ALTERNATIVE,
].join('\n')

const HOLDS_ONE = [
  'The credential group Payments cannot be deleted:',
  '- it holds 1 agent credential; move it to another group or archive it first',
  'Disable it instead to withhold every member from future selection without interrupting any run currently holding one.',
].join('\n')

const ATTACHED_ONLY = [
  'The credential group Payments cannot be deleted:',
  '- it is attached to the execution profile Payments — delegated; detach it there first',
  'Disable it instead to withhold every member from future selection without interrupting any run currently holding one.',
].join('\n')

describe('classifying one condition line (FR-066)', () => {
  it('reads a member credential as the condition fixed on the credentials screen', () => {
    expect(
      classifyDeletionCondition('it holds 4 agent credentials; move them to another group'),
    ).toBe('credential_member')
  })

  it('reads an attachment as the condition fixed on each profile', () => {
    expect(
      classifyDeletionCondition(
        'it is attached to the execution profile Payments — delegated; detach it there first',
      ),
    ).toBe('profile_attachment')
  })

  it('degrades an unrecognised line to its own condition rather than dropping it', () => {
    expect(classifyDeletionCondition('it is doing something the panel has not met')).toBe(
      'unclassified',
    )
  })

  it('gives each condition a code that can be quoted in a ticket', () => {
    expect(deletionConditionCode('credential_member')).toBe('E_CREDENTIAL_GROUP_CREDENTIAL_MEMBER')
    expect(deletionConditionCode('profile_attachment')).toBe(
      'E_CREDENTIAL_GROUP_PROFILE_ATTACHMENT',
    )
  })

  it('sends the two conditions to different places, which is why they are two conditions', () => {
    expect(DELETION_ACTIONS.credential_member).toContain('credentials screen')
    expect(DELETION_ACTIONS.profile_attachment).toContain('execution profile')
    expect(DELETION_ACTIONS.credential_member).not.toBe(DELETION_ACTIONS.profile_attachment)
  })
})

describe('reading a refusal into its conditions', () => {
  it('keeps both conditions apart when both hold', () => {
    const conditions = readDeletionConditions(BOTH_CONDITIONS)

    expect(conditions.map((entry) => entry.condition)).toEqual([
      'credential_member',
      'profile_attachment',
    ])
  })

  it('keeps the router’s own sentence, which carries the counts and the profile names', () => {
    const conditions = readDeletionConditions(BOTH_CONDITIONS)

    expect(conditions[0]?.detail).toContain('4 agent credentials')
    expect(conditions[1]?.detail).toContain('Payments — review')
  })

  it('reports only the condition that applies when only one does', () => {
    expect(readDeletionConditions(HOLDS_ONE).map((entry) => entry.condition)).toEqual([
      'credential_member',
    ])
    expect(readDeletionConditions(ATTACHED_ONLY).map((entry) => entry.condition)).toEqual([
      'profile_attachment',
    ])
  })

  it('does not read the preamble or the disable sentence as conditions', () => {
    for (const entry of readDeletionConditions(BOTH_CONDITIONS)) {
      expect(entry.detail).not.toContain('cannot be deleted')
      expect(entry.detail).not.toContain('Disable it instead')
    }
  })
})

describe('describing a refused delete', () => {
  it('offers disabling in the top-level action, because FR-066 offers it in place of deleting', () => {
    expect(describeDeletionRefusal(refusal(BOTH_CONDITIONS)).error.action).toContain(
      'Disable it instead',
    )
  })

  it('says how many conditions apply and that each is fixed somewhere different', () => {
    expect(describeDeletionRefusal(refusal(BOTH_CONDITIONS)).error.action).toContain(
      '2 conditions apply',
    )
    expect(describeDeletionRefusal(refusal(HOLDS_ONE)).error.action).toContain(
      '1 condition applies',
    )
  })

  it('falls back to the ordinary refusal for a conflict that is not FR-066’s', () => {
    const described = describeDeletionRefusal(
      refusal('The credential group Payments has been deleted and cannot be used.'),
    )

    expect(described.conditions).toEqual([])
    expect(described.error.code).toBe('E_CREDENTIAL_GROUP_DELETE_REFUSED')
  })

  it('does not present a vanished group as an FR-066 condition', () => {
    const described = describeDeletionRefusal({
      message: 'No such credential group, agent credential or execution profile.',
      data: { code: 'NOT_FOUND' },
    })

    expect(described.conditions).toEqual([])
    expect(described.error.code).toBe('E_CREDENTIAL_GROUP_NOT_FOUND')
  })

  it('still answers with a code and an action for something it has never seen', () => {
    const described = describeDeletionRefusal(new Error('socket hang up'))

    expect(described.error.code).toBe('E_UNEXPECTED')
    expect(described.error.action).not.toBe('')
  })
})
