import { DataReadout } from '@sisyphus-admin/components/admin'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldError,
  StateChip,
} from '@sisyphus-admin/components/ui'

import { describeBoundaryError } from './boundary-error'

interface ErrorCardProps {
  /** The error the boundary caught. Only its `digest` is ever read — see `./boundary-error.ts`. */
  readonly error?: { readonly digest?: string }
  /**
   * React's `reset`. Re-renders the segment that threw, which is a real next action for a
   * transient failure and the reason this screen is not just an apology.
   */
  readonly onRetry?: () => void
}

/**
 * What the panel renders when a screen threw while rendering (FR-197, FR-031).
 *
 * ## Why this is a card and not a full-page treatment
 *
 * Because it is mounted inside the shell wherever it can be. The sidebar, the top bar and the skip
 * link are still there, so the operator has not lost the console — one screen failed, and every
 * other one is a click away. A full-bleed error page would take the whole product down to report
 * that a single query threw.
 *
 * ## The chip is the idle graphite one
 *
 * The same rule `NotFoundCard` follows, for the same reason: `rust`, `amber` and `verdigris` report
 * **machine state** (FR-025), and a panel that failed to render is not a run that failed. The error
 * itself is in `rust`, through `FieldError`, because that is what `field-error` is defined as in
 * DESIGN.md — a code and a next action in the refusal colour.
 *
 * ## Two ways out, and both are real
 *
 * `Try again` re-renders the segment, which resolves a transient failure without a reload. The
 * route back is a sibling of this card rather than a control inside it, so the way out of the
 * screen does not read as a way out of the error.
 */
export const ErrorCard = ({ error, onRetry }: ErrorCardProps) => {
  const { content, digest } = describeBoundaryError(error)

  return (
    <Card aria-label="Screen error">
      <CardHeader>
        <span>screen error</span>
        <StateChip>did not render</StateChip>
      </CardHeader>

      <CardBody className="gap-default flex flex-col">
        <p className="type-body text-ink measure-prose">
          This screen stopped part way through rendering, so what you are looking at is incomplete
          rather than empty. Nothing you did caused it and nothing was written.
        </p>

        <FieldError {...content} className="measure-prose" />

        <div className="gap-default flex flex-wrap">
          <DataReadout label="digest" value={digest} />
        </div>

        {onRetry === undefined ? null : (
          <div className="flex">
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
