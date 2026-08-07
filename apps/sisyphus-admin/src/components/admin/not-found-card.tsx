import { Card, CardBody, CardHeader, StateChip } from '@sisyphus-admin/components/ui'

interface NotFoundCardProps {
  /**
   * What was not found, in the caller's words — `No such execution profile.` Must not vary with
   * *why*: see the note below.
   */
  message: string
}

/**
 * What the panel renders when the server answered `NOT_FOUND` (FR-190).
 *
 * ## Why this component exists rather than a message at the call site
 *
 * An out-of-scope read and a target that never existed come back as the **same** error with the
 * **same** message, deliberately: `FORBIDDEN` would answer "does this profile exist?" with yes,
 * and the id in the URL is the caller's guess. That guarantee is only worth as much as the panel's
 * rendering of it. A screen that says "you do not have permission to view this profile" hands back
 * the disclosure the error code was chosen to prevent — the server was careful and the UI told
 * them anyway.
 *
 * So there is one component, it says *not found*, and it has no variant that mentions permission.
 * The chip is the idle graphite one: absence is not a machine state, and colouring it `rust` would
 * report a failure that has not happened.
 */
export const NotFoundCard = ({ message }: NotFoundCardProps) => (
  <Card>
    <CardHeader>
      <span>not found</span>
      <StateChip>not found</StateChip>
    </CardHeader>
    <CardBody>
      <p className="type-body text-graphite measure-prose">{message}</p>
    </CardBody>
  </Card>
)
