import { describe, expect, it } from 'vitest'

import {
  ARTIFACT_KINDS,
  BOOTSTRAP_PHASE_OUTCOMES,
  BOOTSTRAP_PHASES,
  CLAUDE_MODELS,
  CORRECTION_DELIVERY_OUTCOMES,
  ENTRY_RESULTS,
  EXTERNAL_ACTION_KINDS,
  EXTERNAL_ACTION_RESULTS,
  INTEGRATION_TYPES,
  NOTIFICATION_EVENTS,
  PURCHASE_MODES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  SKILL_NAMES,
  SNAPSHOT_BOUNDARIES,
  SUPERVISION_DELIVERY_OUTCOMES,
  TERMINAL_OUTCOMES,
  USER_ROLES,
  WORKFLOW_STATES,
  WORKFLOW_TYPES,
} from '../../enums'

import * as pgEnums from './enums'

const allEnums = Object.values(pgEnums)

/**
 * This file is the **one place** the shared tuples and the database types meet, so it is the one
 * place their agreement is worth asserting. The vocabularies themselves are tested in
 * `src/enums/`, against what each one means; what is tested here is only that the Postgres type
 * carrying a vocabulary carries that vocabulary and no other.
 *
 * A pair below failing means someone hand-edited a `pgEnum` to hold a literal array again, which
 * is how the restatement this file was built to remove would come back.
 */
describe('Postgres enum types', () => {
  it('mirrors every shared vocabulary from src/enums verbatim (FR-009)', () => {
    const pairs = [
      [pgEnums.workflowStateEnum, WORKFLOW_STATES],
      [pgEnums.workflowTypeEnum, WORKFLOW_TYPES],
      [pgEnums.terminalOutcomeEnum, TERMINAL_OUTCOMES],
      [pgEnums.userRoleEnum, USER_ROLES],
      [pgEnums.purchaseModeEnum, PURCHASE_MODES],
      [pgEnums.claudeModelEnum, CLAUDE_MODELS],
      [pgEnums.integrationTypeEnum, INTEGRATION_TYPES],
      [pgEnums.bootstrapPhaseEnum, BOOTSTRAP_PHASES],
      [pgEnums.bootstrapPhaseOutcomeEnum, BOOTSTRAP_PHASE_OUTCOMES],
      [pgEnums.entryResultEnum, ENTRY_RESULTS],
      [pgEnums.snapshotBoundaryEnum, SNAPSHOT_BOUNDARIES],
      [pgEnums.skillNameEnum, SKILL_NAMES],
      [pgEnums.artifactKindEnum, ARTIFACT_KINDS],
      [pgEnums.correctionDeliveryOutcomeEnum, CORRECTION_DELIVERY_OUTCOMES],
      [pgEnums.supervisionDeliveryOutcomeEnum, SUPERVISION_DELIVERY_OUTCOMES],
      [pgEnums.reviewVerdictEnum, REVIEW_VERDICTS],
      [pgEnums.reviewFindingSeverityEnum, REVIEW_FINDING_SEVERITIES],
      [pgEnums.externalActionKindEnum, EXTERNAL_ACTION_KINDS],
      [pgEnums.externalActionResultEnum, EXTERNAL_ACTION_RESULTS],
      [pgEnums.notificationEventEnum, NOTIFICATION_EVENTS],
    ] as const

    for (const [pgEnum, tuple] of pairs) {
      expect(pgEnum.enumValues).toStrictEqual([...tuple])
    }
  })

  it('names the enum types in snake_case, matching the data model', () => {
    expect(pgEnums.workflowStateEnum.enumName).toBe('workflow_state')
    expect(pgEnums.terminalOutcomeEnum.enumName).toBe('terminal_outcome')
    expect(pgEnums.claudeModelEnum.enumName).toBe('claude_model')
    expect(pgEnums.bootstrapPhaseEnum.enumName).toBe('bootstrap_phase')
    expect(pgEnums.notificationEventEnum.enumName).toBe('notification_event')
  })

  it('gives every enum type a unique name, since a Postgres enum type is database-wide', () => {
    const names = allEnums.map((pgEnum) => pgEnum.enumName)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every enum at least one value and no duplicate values', () => {
    for (const pgEnum of allEnums) {
      expect(pgEnum.enumValues.length).toBeGreaterThan(0)
      expect(new Set(pgEnum.enumValues).size).toBe(pgEnum.enumValues.length)
    }
  })

  it('offers exactly one notification channel (FR-136)', () => {
    expect(pgEnums.notificationChannelEnum.enumValues).toStrictEqual(['slack_dm'])
  })

  it('records unnotifiable as an outcome rather than a delivery error (FR-140)', () => {
    expect(pgEnums.notificationOutcomeEnum.enumValues).toContain('unnotifiable')
  })
})
