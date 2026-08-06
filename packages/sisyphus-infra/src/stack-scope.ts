/**
 * The naming scope every Sisyphus stack resolves resources under.
 *
 * Three separate SST apps deploy into one stage — the panel, the control plane
 * and the executor — and they must agree on the name of every resource they
 * share. `$app.name` cannot be that agreement: it differs per deployable by
 * definition. So the project component of a resource name is this fixed
 * constant, and the stack component is the **plain** stage, which is why
 * `getPlainStage` exists: `production`, `production-bootstrap` and
 * `production-website` all name the same buckets and the same database.
 *
 * The practical consequence is that only one app creates a shared resource and
 * the others derive its name from the same builder, rather than each declaring
 * its own — three declarations of one bucket are three chances to disagree
 * about retention.
 */

import { getPlainStage } from './get-plain-stage'
import type { ResourceScope } from './lib'

/** Project component of every resource name, identical across the three apps. */
export const SISYPHUS_PROJECT = 'sisyphus'

/**
 * The scope a resource name is built under for an SST stage.
 *
 * @example
 * getStackScope('production-bootstrap') // → { project: 'sisyphus', stack: 'production' }
 */
export const getStackScope = (sstStage: string): ResourceScope => {
  const stack = getPlainStage(sstStage)

  if (stack.trim() === '') {
    throw new Error('Cannot build a resource scope from an empty stage name')
  }

  return { project: SISYPHUS_PROJECT, stack }
}
