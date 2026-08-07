import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SlackIdentityReadout } from './slack-identity-readout'

const render = (slackUserId: string | null): string =>
  renderToStaticMarkup(<SlackIdentityReadout slackUserId={slackUserId} />)

describe('the Slack identity readout', () => {
  it('states plainly that nothing will be delivered when no identity resolved (FR-140)', () => {
    const markup = render(null)

    expect(markup).toContain('No Slack identity resolved')
    expect(markup).toContain('notifications will not be delivered')
  })

  it('says the preferences below are recorded and still will not reach anyone', () => {
    // The failure this card exists to prevent: a settings screen that appears to have succeeded.
    expect(render(null)).toContain('none of the messages they describe will arrive')
  })

  it('marks the account unnotifiable in the machine’s own vocabulary', () => {
    expect(render(null)).toContain('unnotifiable')
  })

  it('does not imply the run is at risk — delivery is what is missing, not the work (FR-140)', () => {
    const markup = render(null)

    expect(markup).toContain('Nothing about your runs is affected')
    expect(markup).not.toContain('will fail')
  })

  it('gives the caller a next action rather than a dead end (FR-031)', () => {
    expect(render(null)).toContain('Ask an admin to link your platform account')
  })

  it('shows the resolved identity, so the claim can be checked', () => {
    const markup = render('U0429SLACK')

    expect(markup).toContain('U0429SLACK')
    expect(markup).toContain('resolved')
    expect(markup).not.toContain('will not be delivered')
  })

  it('names Slack as the only channel, in both states', () => {
    expect(render('U0429SLACK')).toContain('no email fallback')
    expect(render(null)).toContain('Slack')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    for (const identity of ['U0429SLACK', null]) {
      const markup = render(identity)

      expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
    }
  })
})
