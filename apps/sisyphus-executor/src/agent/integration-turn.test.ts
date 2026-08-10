/**
 * T196 — the two integration turns.
 *
 * The property under test is the same negative one the review turn holds: nothing this module
 * composes says what integration *means*. No merge strategy, no environment, no tag format. The
 * step turn's own decision — name the skill rather than re-quote it — is asserted too, because a
 * run performs several steps against one plan and the instruction is what has to stay closest to
 * the request.
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedSkill } from '../skills'

import {
  INTEGRATION_PLAN_TAG,
  INTEGRATION_STEP_TAG,
  integrationPlanTurnBody,
  integrationStepTurnBody,
} from './integration-turn'
import { answerMarkers } from './proposal-block'

const NONCE = '0ddba11c'

const skill: ResolvedSkill = {
  skillName: 'sisyphus-integration',
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  resolvedPath: '.claude/skills/sisyphus-integration/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-integration/SKILL.md',
  contentDigest: 'ab12cd34'.repeat(8),
  byteSize: 210,
  body: 'The client’s integration rules.',
}

const step = {
  entryId: 'entry-api',
  name: 'promote',
  instruction: 'Promote the change to the shared line.',
}

describe('integrationPlanTurnBody', () => {
  it('quotes the skill and carries the plan block’s markers', () => {
    const body = integrationPlanTurnBody({ skill, nonce: NONCE })

    expect(body).toContain('The client’s integration rules.')
    expect(body).toContain(answerMarkers(INTEGRATION_PLAN_TAG, NONCE).open)
  })

  it('asks for the order in the vocabulary requirePromotionOrder validates in', () => {
    expect(integrationPlanTurnBody({ skill, nonce: NONCE })).toContain('`entryIds`')
  })

  it('takes no action of its own', () => {
    expect(integrationPlanTurnBody({ skill, nonce: NONCE })).toContain('Take no action yet.')
  })
})

describe('integrationStepTurnBody', () => {
  it('carries the instruction verbatim and the run’s key for the action', () => {
    const body = integrationStepTurnBody({ skill, step, idempotencyKey: 'k-1', nonce: NONCE })

    expect(body).toContain('Promote the change to the shared line.')
    expect(body).toContain('k-1')
    expect(body).toContain(answerMarkers(INTEGRATION_STEP_TAG, NONCE).open)
  })

  it('names the skill and its digest rather than re-quoting the body', () => {
    const body = integrationStepTurnBody({ skill, step, idempotencyKey: 'k-1', nonce: NONCE })

    expect(body).toContain('ab12cd34'.repeat(8))
    expect(body).not.toContain('The client’s integration rules.')
  })

  it('says a step that did not happen must report nothing', () => {
    const body = integrationStepTurnBody({ skill, step, idempotencyKey: 'k-1', nonce: NONCE })

    expect(body).toContain('do not emit the block')
  })

  it('states no idea of what integration means', () => {
    const body = integrationStepTurnBody({
      skill,
      step: { ...step, instruction: 'x' },
      idempotencyKey: 'k-1',
      nonce: NONCE,
    })

    for (const opinion of ['squash', 'rebase', 'staging', 'production', 'main', 'release/']) {
      expect(body.toLowerCase()).not.toContain(opinion)
    }
  })
})
