import type { WorkflowRowReadouts } from '@sisyphus-admin/components/workflows'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ReassignmentRow } from './reassignment-row'

const noop = () => undefined

const row: WorkflowRowReadouts = {
  id: '01890a5d-ac96-774b-bcce-b302099a8050',
  runId: '01890a5d…',
  state: 'running',
  stateReadout: 'running 04:21',
  type: 'delegated',
  startedByLabel: 'initiated by',
  startedBy: 'Grace',
  owner: 'Grace',
  workspace: 'Payments',
  ticket: 'PAY-14',
  model: 'claude-opus-5',
  executionProfile: 'Payments — delegated',
  startedAt: '2026-02-01 09:30',
  duration: '04:21',
  turns: '12',
  spend: '3.4000',
  outcome: '—',
}

const render = (props: Partial<Parameters<typeof ReassignmentRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ReassignmentRow
      row={row}
      candidates={[{ value: 'user-1', label: 'Ada — ada@example.com' }]}
      selectedUserId=""
      onSelect={noop}
      onReassign={noop}
      {...props}
    />,
  )

describe('ReassignmentRow (FR-134, FR-176)', () => {
  it('links to the run, so the row is still a way into it', () => {
    expect(render()).toContain('/workflows/01890a5d-ac96-774b-bcce-b302099a8050')
  })

  it('derives the chip from the workflow state rather than choosing one (FR-025)', () => {
    expect(render()).toContain('running 04:21')
  })

  it('says the run was not interrupted, only left unattended', () => {
    expect(render()).toContain('was not interrupted')
  })

  it('says ownership is not profile access, which FR-191 makes explicit', () => {
    expect(render()).toContain('does not grant profile access')
  })

  it('cannot be reassigned until a new owner has been chosen', () => {
    expect(render()).toContain('disabled=""')
  })

  it('says so plainly when there is nobody to hand it to', () => {
    expect(render({ candidates: [] })).toContain('No active user is available')
  })

  it('renders a refusal with its code and next action', () => {
    const markup = render({
      error: { code: 'E_OWNER_NOT_AVAILABLE', action: 'Choose an active user.' },
    })

    expect(markup).toContain('E_OWNER_NOT_AVAILABLE')
  })
})
