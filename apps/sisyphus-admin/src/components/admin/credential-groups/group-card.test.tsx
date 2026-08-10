import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { readDeletionConditions } from './deletion-refusal'
import { CredentialGroupCard } from './group-card'
import type { CredentialGroupReadouts } from './group-listing'

const noop = () => undefined

const group = (patch: Partial<CredentialGroupReadouts> = {}): CredentialGroupReadouts => ({
  id: 'group-1',
  name: 'Payments',
  description: 'The payments pool',
  state: 'enabled',
  credentials: '0',
  attachedProfiles: '0',
  created: '2026-02-01 09:30',
  enabled: true,
  archived: false,
  blockers: [],
  blockerDetails: [],
  ...patch,
})

const render = (props: Partial<Parameters<typeof CredentialGroupCard>[0]> = {}) =>
  renderToStaticMarkup(
    <CredentialGroupCard
      group={group()}
      rename={{ name: 'Payments', description: 'The payments pool' }}
      onRenameChange={noop}
      onRename={noop}
      onSetEnabled={noop}
      onDelete={noop}
      {...props}
    />,
  )

const blockedByCredentials = group({
  credentials: '4',
  blockers: ['credential_member'],
  blockerDetails: [
    'it holds 4 agent credentials; move them to another group or archive them first',
  ],
})

const blockedByBoth = group({
  credentials: '4',
  attachedProfiles: '2',
  blockers: ['credential_member', 'profile_attachment'],
  blockerDetails: [
    'it holds 4 agent credentials; move them to another group or archive them first',
    'it is attached to 2 execution profiles; detach it there first',
  ],
})

describe('CredentialGroupCard (FR-060, FR-067)', () => {
  it('leads with the two counts FR-066 turns on', () => {
    const markup = render()

    expect(markup).toContain('credentials')
    expect(markup).toContain('attached profiles')
  })

  it('offers renaming and enabling, which are the two edits FR-067 audits', () => {
    const markup = render()

    expect(markup).toContain('Rename')
    expect(markup).toContain('Disable')
  })

  it('does nothing to an archived group but say it was deleted', () => {
    const markup = render({ group: group({ archived: true, state: 'deleted' }) })

    expect(markup).toContain('has been deleted')
    expect(markup).not.toContain('Rename')
    expect(markup).not.toContain('Delete')
  })
})

describe('the FR-066 conditions, stated ahead of the attempt', () => {
  it('offers Delete only for a group nothing refers to', () => {
    expect(render()).toContain('Delete')
    expect(render({ group: blockedByCredentials })).not.toContain('>Delete<')
  })

  it('names the member-credential condition rather than saying the group is in use', () => {
    const markup = render({ group: blockedByCredentials })

    expect(markup).toContain('E_CREDENTIAL_GROUP_CREDENTIAL_MEMBER')
    expect(markup).toContain('it holds 4 agent credentials')
    expect(markup).not.toContain('E_CREDENTIAL_GROUP_PROFILE_ATTACHMENT')
  })

  it('states both conditions when both hold, because they are fixed in different places', () => {
    const markup = render({ group: blockedByBoth })

    expect(markup).toContain('E_CREDENTIAL_GROUP_CREDENTIAL_MEMBER')
    expect(markup).toContain('E_CREDENTIAL_GROUP_PROFILE_ATTACHMENT')
    expect(markup).toContain('detach it there first')
  })

  it('offers disabling as the alternative, which is what FR-066 intends instead of deleting', () => {
    const markup = render({ group: blockedByBoth })

    expect(markup).toContain('Disable it instead')
    expect(markup).toContain('no run currently holding one is interrupted')
    expect(markup).toContain('Disable')
  })
})

describe('the FR-066 refusal, once the router has given one', () => {
  const conditions = readDeletionConditions(
    [
      'The credential group Payments cannot be deleted:',
      '- it holds 1 agent credential; move it to another group or archive it first',
      '- it is attached to the execution profile Payments — delegated; detach it there first',
    ].join('\n'),
  )

  it('renders one field error per condition, each with the router’s own sentence', () => {
    const markup = render({ deletionConditions: conditions })

    expect(markup).toContain('it holds 1 agent credential')
    expect(markup).toContain('Payments — delegated')
  })

  it('withdraws the Delete control even when this card’s own counts said nothing blocked it', () => {
    // The listing count excludes archived credentials and the router's sweep does not, so a group
    // can read as deletable here and be refused there. The refusal wins.
    expect(render({ deletionConditions: conditions })).not.toContain('>Delete<')
  })

  it('keeps offering the disable alternative beside the refusal', () => {
    expect(render({ deletionConditions: conditions })).toContain('Disable it instead')
  })
})
