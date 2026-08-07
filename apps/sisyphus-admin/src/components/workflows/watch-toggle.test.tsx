import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * The control's job is small and its security property is not: `watch` and `unwatch` are scoped, so
 * a run the caller may not see is refused with exactly the `NOT_FOUND` a nonexistent id gets, and
 * **this component must not put that distinction back** (FR-190, quickstart Scenario 15 step 6).
 *
 * Three of the assertions below are that property from three directions: the refusal text cannot
 * vary by code, the stance cannot move except on a server answer, and the word "permission" cannot
 * appear. The mount rule — that the control is not rendered at all until the run has resolved — is
 * asserted where it lives, in `workflow-detail-panel.test.tsx`.
 */

const watchMutate = vi.fn()
const unwatchMutate = vi.fn()

vi.mock('@sisyphus-admin/trpc', () => ({
  api: {
    workflow: {
      watch: { useMutation: () => ({ mutate: watchMutate }) },
      unwatch: { useMutation: () => ({ mutate: unwatchMutate }) },
    },
  },
}))

const { WatchToggle, WATCH_REFUSED, describeWatchError, describeWatchOutcome } =
  await import('./watch-toggle')

const WORKFLOW_ID = '0199a1f4-0000-7000-8000-0000000000ab'

const source = readFileSync(new URL('./watch-toggle.tsx', import.meta.url), 'utf8')

/** The source with its comments removed, so prose about a rule cannot satisfy a test of the rule. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const render = (): string => renderToStaticMarkup(<WatchToggle workflowId={WORKFLOW_ID} />)

describe('refusing a watch', () => {
  it('says the same thing for FORBIDDEN as for NOT_FOUND (FR-190)', () => {
    const absent = describeWatchError({ data: { code: 'NOT_FOUND' } })
    const forbidden = describeWatchError({ data: { code: 'FORBIDDEN' } })

    expect(absent).toStrictEqual(forbidden)
    expect(absent).toStrictEqual(WATCH_REFUSED)
  })

  it('never mentions permission, which would confirm the run exists', () => {
    for (const trpcCode of ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'INTERNAL_SERVER_ERROR']) {
      const described = describeWatchError({ data: { code: trpcCode } })

      expect(`${described.code} ${described.action}`.toLowerCase()).not.toContain('permission')
      expect(`${described.code} ${described.action}`.toLowerCase()).not.toContain('not allowed')
    }
  })

  it('still gives a code and a next action, so a refusal is not a dead end (FR-031)', () => {
    expect(WATCH_REFUSED.code).toBe('E_RUN_NOT_FOUND')
    expect(WATCH_REFUSED.action.length).toBeGreaterThan(0)
  })

  it('leaves an unexpected failure on the catch-all rather than inventing a reason', () => {
    expect(describeWatchError(undefined).code).toBe('E_UNEXPECTED')
  })
})

describe('reporting what the server did', () => {
  it('reports a watch that took effect', () => {
    expect(
      describeWatchOutcome({ workflowId: WORKFLOW_ID, watching: true, changed: true }),
    ).toMatchObject({
      readout: 'watching',
    })
  })

  it('reports a repeated watch as already held, not as an error', () => {
    const notice = describeWatchOutcome({ workflowId: WORKFLOW_ID, watching: true, changed: false })

    expect(notice.readout).toBe('already watching')
    expect(notice.detail).toContain('Nothing changed')
  })

  it('reports an unwatch, and an unwatch of something never followed', () => {
    expect(
      describeWatchOutcome({ workflowId: WORKFLOW_ID, watching: false, changed: true }).readout,
    ).toBe('not watching')
    expect(
      describeWatchOutcome({ workflowId: WORKFLOW_ID, watching: false, changed: false }).detail,
    ).toContain('Nothing changed')
  })
})

describe('the control itself', () => {
  it('offers watching for any run it is mounted on, not only one the caller owns (FR-138)', () => {
    const markup = render()

    expect(markup).toContain('Watch this run')
    expect(markup).toContain('whoever owns it')
  })

  it('admits it cannot read the current setting rather than guessing one', () => {
    const markup = render()

    expect(markup).toContain('cannot read whether you already follow it')
    expect(markup).toContain('not read')
    // Both directions are offered while the stance is unknown, and either is safe to press twice.
    expect(markup).toContain('Stop watching')
  })

  it('takes the id as its only input, so it cannot resolve the run for itself', () => {
    expect(WatchToggle).toHaveLength(1)
  })

  it('moves its stance only on an answer from the server (FR-190)', () => {
    // An optimistic flip would render `watching` for the instant before a refusal arrived, and a
    // button that went green briefly is an answer to "does this run exist?".
    const settles = code.match(/setOutcome\(/g) ?? []

    expect(settles).toHaveLength(1)
    expect(code).toContain('onSuccess: settle')
    expect(code.split('const refuse =')[1]).not.toContain('setOutcome')
  })

  it('calls the two scoped procedures and nothing else', () => {
    expect(code).toContain('api.workflow.watch.useMutation')
    expect(code).toContain('api.workflow.unwatch.useMutation')
    expect(code).not.toContain('api.workflow.byId')
  })

  it('is operable from the keyboard with a visible focus ring (FR-201)', () => {
    const markup = render()

    expect(markup).toContain('<button')
    expect(markup).toContain('focus-ring')
  })

  it('writes no literal colour, size or radius (SC-015)', () => {
    const markup = render()

    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(markup).not.toMatch(/style="[^"]*\d+(px|rem)/)
  })
})
