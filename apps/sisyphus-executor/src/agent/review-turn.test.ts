/**
 * T196 — the review turn, and the one property that has to hold about it.
 *
 * It quotes the skill and composes no rubric of its own. The assertion that matters is the negative
 * one: no severity threshold, no category of defect and no ticket state appears in the text this
 * module contributes, because every one of them is the client's and is stated in
 * `sisyphus-review` (FR-057).
 */

import { describe, expect, it } from 'vitest'

import type { ReviewRequest, ReviewTarget } from '../workflows'

import { answerMarkers } from './proposal-block'
import { renderTargets, REVIEW_TAG, reviewTurnBody } from './review-turn'

const NONCE = 'f00dcafe'

const target = (over: Partial<ReviewTarget> = {}): ReviewTarget => ({
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  repository: 'acme/service',
  pullRequestNumber: 41,
  pullRequestUrl: 'https://forge.example/acme/service/pull/41',
  ...over,
})

const requestFor = (
  body: string,
  targets: readonly ReviewTarget[] = [target()],
): ReviewRequest => ({
  skill: {
    skillName: 'sisyphus-review',
    entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
    resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
    absolutePath: '/workspace/primary/.claude/skills/sisyphus-review/SKILL.md',
    contentDigest: 'ab12cd34'.repeat(8),
    byteSize: 320,
    body,
  },
  targets,
})

describe('reviewTurnBody', () => {
  it('quotes the skill verbatim, fenced and attributed to its digest', () => {
    const body = reviewTurnBody({
      request: requestFor('Block anything that touches billing without a test.'),
      nonce: NONCE,
    })

    expect(body).toContain('Block anything that touches billing without a test.')
    expect(body).toContain('<<<skill:sisyphus-review')
    expect(body).toContain('ab12cd34'.repeat(8))
  })

  it('carries this request’s own markers', () => {
    const body = reviewTurnBody({ request: requestFor('rubric'), nonce: NONCE })

    expect(body).toContain(answerMarkers(REVIEW_TAG, NONCE).open)
    expect(body).toContain(answerMarkers(REVIEW_TAG, NONCE).close)
  })

  it('states no rubric of its own', () => {
    const body = reviewTurnBody({ request: requestFor('the client’s rubric'), nonce: NONCE })
    const composed = body.replace('the client’s rubric', '')

    // Every word that would be an opinion about what a review should catch, or about where a ticket
    // goes afterwards. The skill's body is removed first, so a skill that used one of these words
    // cannot make this pass or fail.
    for (const opinion of [
      'test coverage',
      'lint',
      'security',
      'performance',
      'in progress',
      'in review',
      'done',
    ]) {
      expect(composed.toLowerCase()).not.toContain(opinion)
    }
  })

  it('names the pass it is reviewing, so an iteration-three review says so', () => {
    const body = reviewTurnBody({ request: { ...requestFor('rubric'), ordinal: 3 }, nonce: NONCE })

    expect(body).toContain('development pass 3')
  })
})

describe('renderTargets', () => {
  it('shows one target as one', () => {
    expect(renderTargets([target()])).toContain('One pull request is under review')
  })

  it('shows a set as one change with one verdict (FR-119)', () => {
    const rendered = renderTargets([
      target(),
      target({ entryId: 'entry-b', repository: 'acme/web', pullRequestNumber: 12 }),
    ])

    expect(rendered).toContain('2 pull requests are under review and are one change')
    expect(rendered).toContain('single verdict over the set')
    // The entry id is what a finding anchors to, so it has to be visible per target (FR-119).
    expect(rendered).toContain('workspace entry entry-b')
  })
})
