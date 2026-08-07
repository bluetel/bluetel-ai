import { describe, expect, it } from 'vitest'

import type { DevelopmentRequest } from '../workflows'
import { FORBIDDEN_LITERALS } from '../workflows'

import {
  developTurnBody,
  renderFeedback,
  renderFinding,
  renderReportInstruction,
} from './develop-turn'
import { proposalMarkers } from './proposal-block'

const skill: DevelopmentRequest['skill'] = {
  skillName: 'sisyphus-dev',
  entryId: 'a3f0c2d4-0000-4000-8000-000000000001',
  resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
  absolutePath: '/workspace/primary/.claude/skills/sisyphus-dev/SKILL.md',
  contentDigest: 'ab12cd34'.repeat(8),
  byteSize: 812,
  body: 'Branch from the integration line and name the branch after the ticket.',
}

const request = (over: Partial<DevelopmentRequest> = {}): DevelopmentRequest => ({
  ordinal: 1,
  skill,
  feedback: [],
  ...over,
})

const NONCE = 'b17c0de5'

describe('developTurnBody', () => {
  it('quotes the skill body verbatim', () => {
    expect(developTurnBody({ request: request(), nonce: NONCE })).toContain(skill.body)
  })

  it('names where the skill was read and its digest, so the pass is explicable later', () => {
    const body = developTurnBody({ request: request(), nonce: NONCE })

    expect(body).toContain(skill.resolvedPath)
    expect(body).toContain(skill.contentDigest)
  })

  it('names the pass so a later pass is not confused with the first', () => {
    expect(developTurnBody({ request: request({ ordinal: 3 }), nonce: NONCE })).toContain(
      'Development pass 3',
    )
  })

  it('carries this request’s markers and no other', () => {
    const body = developTurnBody({ request: request(), nonce: NONCE })
    const { open, close } = proposalMarkers(NONCE)

    expect(body).toContain(open)
    expect(body).toContain(close)
    expect(body).not.toContain(proposalMarkers('a-different-request').open)
  })

  it('states no convention of its own (FR-057)', () => {
    // The same families `hardcoded-convention-scan.ts` refuses in `src/workflows`, applied to the
    // one string in this codebase that is composed for the agent and could carry one. The skill
    // body is excluded because the skill is the client's and is quoted, not composed.
    const composed = developTurnBody({ request: request(), nonce: NONCE }).replace(skill.body, '')

    for (const forbidden of FORBIDDEN_LITERALS) {
      for (const line of composed.split('\n')) {
        expect(
          forbidden.pattern.test(line.trim()),
          `${forbidden.name} in composed turn text: ${line}`,
        ).toBe(false)
      }
    }
  })
})

describe('renderFeedback', () => {
  it('says plainly that there was no earlier pass', () => {
    expect(renderFeedback([])).toContain('No earlier pass has been reviewed')
  })

  it('renders every finding, in order', () => {
    const rendered = renderFeedback([
      { severity: 'blocker', summary: 'the endpoint is unauthenticated' },
      { severity: 'minor', summary: 'the test name is misleading' },
    ])

    expect(rendered).toContain('the endpoint is unauthenticated')
    expect(rendered).toContain('the test name is misleading')
    expect(rendered.indexOf('unauthenticated')).toBeLessThan(rendered.indexOf('misleading'))
  })
})

describe('renderFinding', () => {
  it('anchors a finding to its file and line', () => {
    expect(
      renderFinding({
        severity: 'blocker',
        summary: 'no authorisation check',
        filePath: 'src/routes/orders.ts',
        line: 42,
      }),
    ).toBe('- [blocker] src/routes/orders.ts:42 no authorisation check')
  })

  it('anchors a finding to its workspace entry when the reviewer named one', () => {
    expect(
      renderFinding({
        severity: 'major',
        summary: 'the client was not regenerated',
        workflowEntryId: 'a3f0c2d4-0000-4000-8000-000000000002',
      }),
    ).toContain('a3f0c2d4-0000-4000-8000-000000000002')
  })

  it('renders a finding carrying nothing but a severity and a sentence', () => {
    expect(renderFinding({ severity: 'minor', summary: 'tidy the imports' })).toBe(
      '- [minor] tidy the imports',
    )
  })
})

describe('renderReportInstruction', () => {
  it('asks for every field the reader can read back', () => {
    const instruction = renderReportInstruction(NONCE)

    for (const key of [
      'conventions',
      'summary',
      'entries',
      'decisions',
      'assumptions',
      'notDone',
      'uncertainties',
      'ticketInstruction',
      'ticketState',
      'wasChanged',
    ]) {
      expect(instruction).toContain(key)
    }
  })

  it('says that an omitted field is not filled in', () => {
    expect(renderReportInstruction(NONCE)).toContain('is not filled in')
  })

  it('says that an empty list and a missing list are different', () => {
    expect(renderReportInstruction(NONCE)).toContain('not the same thing')
  })
})
