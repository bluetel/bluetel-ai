import type { CandidateItem } from '@bluetel-ai/sisyphus-api/contracts'
import { describe, expect, it } from 'vitest'

import { commentKey, hasMarker, renderCommentBody, renderMarker } from './comment-body'

const item: CandidateItem = {
  externalId: 'SIS-1',
  title: 'Fix the thing',
  url: 'https://example.atlassian.net/browse/SIS-1',
  body: null,
  assigneeEmail: null,
  comments: [],
  attributes: {},
}

const pickup = {
  kind: 'picked_up',
  workflowId: 'wf-1',
  workflowUrl: 'https://sisyphus.example/workflows/wf-1',
} as const

describe('commentKey', () => {
  it('is the shared external-action key format', () => {
    expect(commentKey(item, pickup)).toBe('jira-comment:wf-1:SIS-1:picked_up')
  })

  it('separates the pickup comment from the outcome comment of the same run', () => {
    // Keyed by ticket alone, the outcome comment would replay as the pickup and never be posted.
    const outcome = commentKey(item, {
      kind: 'outcome',
      workflowId: 'wf-1',
      outcome: 'completed',
      pullRequestUrls: [],
    })

    expect(outcome).not.toBe(commentKey(item, pickup))
  })

  it('does not move when the rendered text moves', () => {
    // A retry that rendered a different URL has to be the same action, or the duplicate walks
    // back in through the thing most likely to vary.
    const withDifferentUrl = commentKey(item, { ...pickup, workflowUrl: 'https://elsewhere/x' })

    expect(withDifferentUrl).toBe(commentKey(item, pickup))
  })

  it('keys a skip by its reason, with no workflow to name', () => {
    expect(commentKey(item, { kind: 'skipped', reason: 'no_mapping_matched' })).toBe(
      'jira-comment:no-workflow:SIS-1:skipped:no_mapping_matched',
    )
  })

  it('does not move when only the free-text detail of a skip changes', () => {
    const bare = commentKey(item, { kind: 'skipped', reason: 'ceiling_reached' })
    const detailed = commentKey(item, {
      kind: 'skipped',
      reason: 'ceiling_reached',
      detail: 'Reached 12 of 12 runs at 09:31.',
    })

    // Otherwise every tick would post the same explanation again with a new timestamp in it.
    expect(detailed).toBe(bare)
  })

  it('lets a ticket skipped for a second, different reason say so', () => {
    const noMapping = commentKey(item, { kind: 'skipped', reason: 'no_mapping_matched' })
    const ceiling = commentKey(item, { kind: 'skipped', reason: 'ceiling_reached' })

    expect(noMapping).not.toBe(ceiling)
  })

  it('separates two runs commenting on the same ticket', () => {
    expect(commentKey(item, { ...pickup, workflowId: 'wf-2' })).not.toBe(commentKey(item, pickup))
  })
})

describe('renderCommentBody', () => {
  it('links the run on pickup, and carries the marker', () => {
    const body = renderCommentBody(pickup, commentKey(item, pickup))

    expect(body).toContain('https://sisyphus.example/workflows/wf-1')
    expect(hasMarker(body, commentKey(item, pickup))).toBe(true)
  })

  it('states the reason a ticket was not started, in words a human reads', () => {
    const event = { kind: 'skipped', reason: 'no_mapping_matched' } as const
    const body = renderCommentBody(event, commentKey(item, event))

    expect(body).toContain('no execution profile mapping matched')
  })

  it('adds the free-text detail when there is one', () => {
    const event = {
      kind: 'skipped',
      reason: 'ceiling_reached',
      detail: 'Deferred to the next tick.',
    } as const

    expect(renderCommentBody(event, 'k')).toContain('Deferred to the next tick.')
  })

  it('lists every pull request on the outcome', () => {
    const event = {
      kind: 'outcome',
      workflowId: 'wf-1',
      outcome: 'completed',
      pullRequestUrls: ['https://github.com/acme/api/pull/1', 'https://github.com/acme/web/pull/2'],
    } as const

    const body = renderCommentBody(event, 'k')

    expect(body).toContain('- https://github.com/acme/api/pull/1')
    expect(body).toContain('- https://github.com/acme/web/pull/2')
  })

  it('says plainly when a finished run opened no pull request', () => {
    const event = {
      kind: 'outcome',
      workflowId: 'wf-1',
      outcome: 'halted',
      pullRequestUrls: [],
    } as const

    expect(renderCommentBody(event, 'k')).toContain('No pull request was opened.')
  })
})

describe('hasMarker', () => {
  it('matches only its own key', () => {
    const body = `done\n\n${renderMarker('a:b')}`

    expect(hasMarker(body, 'a:b')).toBe(true)
    expect(hasMarker(body, 'a:c')).toBe(false)
    expect(hasMarker(undefined, 'a:b')).toBe(false)
  })
})
