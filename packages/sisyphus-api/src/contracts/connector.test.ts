import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  CandidateItem,
  IntegrationConnector,
  IntegrationMapping,
  MappingResolution,
  WriteBackEvent,
} from './connector'

interface FakeConfig {
  readonly baseUrl: string
}

/**
 * A connector that does nothing, written only so the contract is exercised as something
 * implementable rather than only as a set of type aliases. If a method is added, this stops
 * compiling — which is the point.
 */
const stubConnector: IntegrationConnector<FakeConfig> = {
  type: 'jira',
  validate: () => Promise.resolve({ ok: true, checks: [] }),
  discover: () => Promise.resolve([]),
  resolveProfile: () => ({ matched: false, reason: 'no mappings' }),
  assemblePromptParts: (item) => ({
    title: item.title,
    url: item.url,
    body: item.body,
    comments: [],
    truncatedComments: 0,
  }),
  writeBack: () =>
    Promise.resolve({ key: 'k', disposition: 'performed' as const, reference: 'c-1' }),
}

describe('connector contract', () => {
  it('is implementable, and its type is drawn from the platform vocabulary', () => {
    expectTypeOf(stubConnector.type).toEqualTypeOf<'jira'>()
  })

  it('offers no way to resolve a profile without a match', () => {
    // The absence is the requirement (FR-130): there is no shape carrying both `matched: false`
    // and a profile id, so a connector cannot express a guess even by accident.
    expectTypeOf<Extract<MappingResolution, { matched: false }>>().not.toExtend<{
      executionProfileId: string
    }>()

    const unmatched = stubConnector.resolveProfile({} as CandidateItem, [])
    expect(unmatched.matched).toBe(false)
  })

  it('requires a run on the write-back events that have one, and none on a skip', () => {
    expectTypeOf<Extract<WriteBackEvent, { kind: 'picked_up' }>>().toExtend<{
      workflowId: string
    }>()
    expectTypeOf<Extract<WriteBackEvent, { kind: 'outcome' }>>().toExtend<{ workflowId: string }>()
    // A skip explains why no run was started, so it cannot name one.
    expectTypeOf<Extract<WriteBackEvent, { kind: 'skipped' }>>().not.toExtend<{
      workflowId: string
    }>()
  })

  it('closes the skip reason vocabulary, because the reason is part of the action identity', () => {
    expectTypeOf<
      Extract<WriteBackEvent, { kind: 'skipped' }>['reason']
    >().not.toEqualTypeOf<string>()
  })

  it('accepts a stored mapping row structurally, without contracts depending on the database', () => {
    const storedRow = {
      id: 'm-1',
      integrationId: 'i-1',
      position: 0,
      criteria: { component: 'api' },
      executionProfileId: 'p-1',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    expectTypeOf(storedRow).toExtend<IntegrationMapping>()
  })

  it('carries multi-valued attributes without flattening them into a delimited string', () => {
    expectTypeOf<CandidateItem['attributes']>().toExtend<
      Readonly<Record<string, string | readonly string[]>>
    >()
    expectTypeOf<Readonly<Record<string, string>>>().toExtend<CandidateItem['attributes']>()
  })
})
