import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { skillReferences } from '../../db'
import { reportSkillReferenceInput } from '../../schemas'
import type { MachineCredential } from '../context'
import { readSkillReferences, summariseSkillReferences } from '../workflow'

import { reportSkillReference, REPORT_SKILL_REFERENCE_PATH } from './skill-references'
import type { MachineFixture } from './test-support'
import { createMachineFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * `machine.reportSkillReference` — the write that `workflow.skillReferences` had been reading for
 * (T179, FR-058, FR-059, FR-018, SC-014, SC-016).
 *
 * The suite that matters most here is the last one: the executor's report goes in through this
 * procedure and comes out of the panel's own read path, unchanged. Until this procedure existed
 * that read could only ever return an empty list, and an empty list looks exactly like a run that
 * resolved nothing — so proving the two halves meet is the whole of the task.
 */

const connectionString = readTestDatabaseUrl()

/** The digest of some `sisyphus-dev/SKILL.md` as it stood when a run read it. */
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

describe('the skill-reference payload', () => {
  it('requires only the skill name, so a recorded absence is expressible (FR-058)', () => {
    const parsed = reportSkillReferenceInput.parse({
      skillName: 'sisyphus-review',
      unavailableReason: 'missing: no skill file was found in the primary entry',
    })

    expect(parsed.resolvedPath).toBeUndefined()
    expect(parsed.contentDigest).toBeUndefined()
  })

  it('refuses a skill name outside the platform vocabulary', () => {
    expect(() => reportSkillReferenceInput.parse({ skillName: 'sisyphus-deploy' })).toThrow()
  })
})

describe.skipIf(connectionString === undefined)('reportSkillReference', () => {
  let fixture: MachineFixture
  let credential: MachineCredential

  beforeAll(async () => {
    fixture = createMachineFixture(connectionString ?? '')
    await fixture.open()
    credential = await fixture.seedCredential(fixture.ids().a.workflowId)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('records a resolution with the digest that pins its version (FR-059)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportSkillReference(ctx, {
      skillName: 'sisyphus-dev',
      entryId: fixture.ids().a.workflowEntryId,
      resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
      contentDigest: DIGEST_A,
      phase: 'develop',
    })

    expect(report.recorded).toBe(true)
    expect(report.reference.workflowId).toBe(fixture.ids().a.workflowId)
    expect(report.reference.contentDigest).toBe(DIGEST_A)
    expect(report.reference.entryId).toBe(fixture.ids().a.workflowEntryId)
    expect(report.reference.unavailableReason).toBeNull()
  })

  it('writes nothing on an identical retry, and answers rather than raising (FR-047)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const first = await reportSkillReference(ctx, {
      skillName: 'sisyphus-review',
      entryId: fixture.ids().a.workflowEntryId,
      resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
      contentDigest: DIGEST_A,
      phase: 'review',
    })
    const retry = await reportSkillReference(ctx, {
      skillName: 'sisyphus-review',
      entryId: fixture.ids().a.workflowEntryId,
      resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
      contentDigest: DIGEST_A,
      phase: 'review',
    })

    expect(first.recorded).toBe(true)
    expect(retry.recorded).toBe(false)
    expect(retry.reference.id).toBe(first.reference.id)

    const rows = await fixture
      .db()
      .select()
      .from(skillReferences)
      .where(eq(skillReferences.workflowId, fixture.ids().a.workflowId))

    expect(rows.filter((row) => row.skillName === 'sisyphus-review')).toHaveLength(1)
  })

  it('records a second row when the digest differs — the file changed mid-run', async () => {
    const { ctx } = fixture.contextFor(credential)

    const changed = await reportSkillReference(ctx, {
      skillName: 'sisyphus-review',
      entryId: fixture.ids().a.workflowEntryId,
      resolvedPath: '.claude/skills/sisyphus-review/SKILL.md',
      contentDigest: DIGEST_B,
      phase: 'review',
    })

    expect(changed.recorded).toBe(true)
    expect(changed.reference.contentDigest).toBe(DIGEST_B)
  })

  it('records an absence with its reason and no digest (FR-058)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportSkillReference(ctx, {
      skillName: 'sisyphus-integration',
      entryId: fixture.ids().a.workflowEntryId,
      phase: 'integration',
      unavailableReason: 'missing: no skill file was found in the primary entry',
    })

    expect(report.recorded).toBe(true)
    expect(report.reference.resolvedPath).toBeNull()
    expect(report.reference.contentDigest).toBeNull()
    expect(report.reference.unavailableReason).toBe(
      'missing: no skill file was found in the primary entry',
    )
  })

  it('de-duplicates an absence too — a halt is retried like anything else', async () => {
    const { ctx } = fixture.contextFor(credential)

    const retry = await reportSkillReference(ctx, {
      skillName: 'sisyphus-integration',
      entryId: fixture.ids().a.workflowEntryId,
      phase: 'integration',
      unavailableReason: 'missing: no skill file was found in the primary entry',
    })

    expect(retry.recorded).toBe(false)
  })

  it('accepts a run-wide resolution naming no entry (FR-110)', async () => {
    const { ctx } = fixture.contextFor(credential)

    const report = await reportSkillReference(ctx, {
      skillName: 'sisyphus-dev',
      resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
      contentDigest: DIGEST_B,
      phase: 'bootstrap',
    })

    expect(report.recorded).toBe(true)
    expect(report.reference.entryId).toBeNull()
    // The null-entry row is distinct from the entry-anchored one written above, and a retry of it
    // must match on `entryId is null` rather than on nothing at all.
    expect(
      (
        await reportSkillReference(ctx, {
          skillName: 'sisyphus-dev',
          resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
          contentDigest: DIGEST_B,
          phase: 'bootstrap',
        })
      ).recorded,
    ).toBe(false)
  })

  describe('an entry belonging to another workflow', () => {
    it('is refused and recorded as a cross-workflow write (FR-018, SC-014)', async () => {
      const { ctx, denials } = fixture.contextFor(credential)

      const refusal = await refusalOf(async () =>
        reportSkillReference(ctx, {
          skillName: 'sisyphus-dev',
          entryId: fixture.ids().b.workflowEntryId,
          resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
          contentDigest: DIGEST_A,
          phase: 'develop',
        }),
      )

      expect(refusal.code).toBe('FORBIDDEN')
      expect(denials[0]).toMatchObject({
        reason: 'cross_workflow_write',
        path: REPORT_SKILL_REFERENCE_PATH,
      })

      const leaked = await fixture
        .db()
        .select()
        .from(skillReferences)
        .where(eq(skillReferences.workflowId, fixture.ids().b.workflowId))

      expect(leaked).toStrictEqual([])
    })
  })

  describe('the panel read this write exists for', () => {
    it('returns what the executor reported, digests intact (SC-016)', async () => {
      const summary = summariseSkillReferences(
        await readSkillReferences({
          db: fixture.db(),
          scope: await fixture.scopeFor(fixture.ids().alice),
          workflowId: fixture.ids().a.workflowId,
        }),
      )

      // Before this procedure existed the read could only ever return this empty.
      expect(summary.references.length).toBeGreaterThan(0)
      expect(summary.unavailableSkills).toContain('sisyphus-integration')
      // Every resolution carries the digest that pins which version the run read — FR-059 stated
      // as a boolean.
      expect(summary.explicable).toBe(true)
      expect(
        summary.references.filter((reference) => reference.skillName === 'sisyphus-review'),
      ).toHaveLength(2)
    })
  })
})
