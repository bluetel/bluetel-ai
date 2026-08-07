import { describe, expect, it } from 'vitest'

import * as fleet from './index'

describe('the fleet barrel', () => {
  it('publishes the screen and the shaping its tests reach for', () => {
    expect(Object.keys(fleet).sort()).toStrictEqual([
      'DEFAULT_FLEET_GROUPING',
      'FLEET_SPEND_GROUPINGS',
      'FleetPanel',
      'GROUPING_LABELS',
      'GROUPING_PARAM',
      'SpendSummaryCard',
      'UNATTRIBUTED',
      'isFleetGrouping',
      'parseSpendGrouping',
      'toSpendGroupReadouts',
      'toSpendReadouts',
      'toSpendSummaryInput',
    ])
  })

  it('re-implements nothing the fleet list already owns', () => {
    // The filter bar, the list and the row shaping stay in `components/workflows`. A copy here
    // would be a second definition of FR-013's filter set and a second query string to keep in step.
    for (const owned of [
      'WorkflowFilterBar',
      'WorkflowList',
      'toWorkflowRowReadouts',
      'parseWorkflowFilters',
      'formatTimestamp',
      'cn',
    ]) {
      expect(Object.keys(fleet)).not.toContain(owned)
    }
  })
})
