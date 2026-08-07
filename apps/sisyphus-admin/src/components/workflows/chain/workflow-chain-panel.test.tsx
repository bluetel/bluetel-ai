import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ChainMember } from './chain-model'
import type { LoadedChain } from './chain-walk'
import { WorkflowChainPanel } from './workflow-chain-panel'

/**
 * The panel is presentational, so it is rendered rather than mocked.
 *
 * What is asserted is what FR-152 actually asks for — that the reader can **get to** the run before
 * and the run after — plus the two things a chain view gets wrong quietly: a total that reads as
 * the whole chain when it is the visible part of one, and a blank where "continued by" would go,
 * which reads as "nothing continued this".
 */

const member = (
  overrides: Partial<ChainMember> & { readonly workflowId: string },
): ChainMember => ({
  predecessorWorkflowId: null,
  state: 'succeeded',
  terminalOutcome: 'succeeded',
  model: 'claude-opus-5',
  turnCap: 40,
  spendCap: '25.0000',
  turnsUsed: 3,
  spendUsed: '11.0000',
  createdAt: new Date('2026-08-05T09:00:00.000Z'),
  updatedAt: new Date('2026-08-05T09:10:00.000Z'),
  ...overrides,
})

const A = member({ workflowId: 'run-a' })
const B = member({ workflowId: 'run-b', predecessorWorkflowId: 'run-a', spendUsed: '7.0000' })
const C = member({ workflowId: 'run-c', predecessorWorkflowId: 'run-b', spendUsed: '2.0000' })

const chainOf = (members: readonly ChainMember[], reachedLatest: boolean): LoadedChain => ({
  members,
  completeness: { reachedRoot: true, reachedLatest },
})

const render = (props: Parameters<typeof WorkflowChainPanel>[0]): string =>
  renderToStaticMarkup(<WorkflowChainPanel {...props} />)

describe('WorkflowChainPanel', () => {
  it('links to the run before and the run after — traversal in both directions (FR-152)', () => {
    const markup = render({
      requestedWorkflowId: 'run-b',
      chain: chainOf([A, B, C], true),
    })

    expect(markup).toContain('continues')
    expect(markup).toContain('continued by')
    expect(markup).toContain('href="/workflows/run-a/chain"')
    expect(markup).toContain('href="/workflows/run-c/chain"')
  })

  it('makes every run in the chain reachable, not only the neighbours', () => {
    const markup = render({ requestedWorkflowId: 'run-a', chain: chainOf([A, B, C], true) })

    expect(markup).toContain('href="/workflows/run-b/chain"')
    expect(markup).toContain('href="/workflows/run-c/chain"')
  })

  it('marks the run whose page this is in place rather than linking to it', () => {
    const markup = render({ requestedWorkflowId: 'run-b', chain: chainOf([A, B, C], true) })

    expect(markup).toContain('(this run)')
    expect(markup).not.toContain('href="/workflows/run-b/chain"')
  })

  it('sums consumption across the chain (FR-152)', () => {
    const markup = render({ requestedWorkflowId: 'run-a', chain: chainOf([A, B, C], true) })

    expect(markup).toContain('runs in chain')
    expect(markup).toContain('>3<')
    // 11 + 7 + 2, at the platform's four decimal places.
    expect(markup).toContain('20.0000')
    expect(markup).toContain('turns across chain')
  })

  it('says the totals are over the chain the caller can see (FR-190)', () => {
    const markup = render({ requestedWorkflowId: 'run-a', chain: chainOf([A], true) })

    expect(markup).toContain('permitted to see')
    expect(markup).toContain('is not counted in these figures')
  })

  it('says plainly that nothing continues the latest run when that is established', () => {
    const markup = render({ requestedWorkflowId: 'run-c', chain: chainOf([A, B, C], true) })

    expect(markup).toContain('this is the latest run of the chain')
    expect(markup).toContain('both directions')
  })

  it('never leaves the forward direction blank when it is merely unknown', () => {
    const markup = render({ requestedWorkflowId: 'run-c', chain: chainOf([A, B, C], false) })

    expect(markup).toContain('not established from this view')
    expect(markup).toContain('backwards only')
    // The false claim this exists to prevent.
    expect(markup).not.toContain('this is the latest run of the chain')
  })

  it('renders an out-of-scope run as not found, with no mention of permission (FR-190)', () => {
    const markup = render({ requestedWorkflowId: 'run-a', chain: undefined, notFound: true })

    expect(markup).toContain('not found')
    expect(markup).toContain('No such run.')
    expect(markup.toLowerCase()).not.toContain('forbidden')
    expect(markup.toLowerCase()).not.toContain('not allowed')
  })

  it('says it is reading rather than showing an empty chain', () => {
    const markup = render({ requestedWorkflowId: 'run-a', chain: undefined, loading: true })

    expect(markup).toContain('reading')
    expect(markup).not.toContain('no runs in this chain')
  })

  it('never renders an uncapped run as a cap of zero', () => {
    const uncapped = member({ workflowId: 'run-u', turnCap: null, spendCap: null })
    const markup = render({ requestedWorkflowId: 'run-u', chain: chainOf([uncapped], true) })

    expect(markup).toContain('uncapped')
    expect(markup).not.toContain('/ 0<')
  })

  it('carries no literal colour or measurement — every value is a token (SC-015)', () => {
    const markup = render({ requestedWorkflowId: 'run-b', chain: chainOf([A, B, C], true) })

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/\d+(?:\.\d+)?(?:px|rem|em)\b/)
    expect(markup).not.toContain('style=')
  })
})
