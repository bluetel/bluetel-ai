import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SisyphusDatabase } from '../../db'
import { skillReferences } from '../../db'
import type { ResolvedScope } from '../scope'

import type { SkillReferenceReadout } from './skills'
import { isResolvedSkill, readSkillReferences, summariseSkillReferences } from './skills'
import type { TwoProfileFixture, TwoProfileIds } from './test-support'
import { createTwoProfileFixture, readTestDatabaseUrl, refusalOf } from './test-support'

/**
 * **FR-059, SC-016 — a past run stays explicable after the skills change.**
 *
 * The property under test is not "the query returns rows". It is that the answer is a fact about
 * the run rather than about the repository: two runs that read the same skill at different times
 * report **different digests**, and neither answer moves when the skill moves. That is the whole of
 * FR-059, and it is why the fixture below records one digest for the earlier run and a different
 * one for the later run of the same skill name.
 *
 * A test that only checked one run against one digest would pass against an implementation that
 * hashed the file on disk at read time — which would be the exact defect FR-059 exists to prevent,
 * because it would answer "what does the skill say now" while looking like it had answered "what
 * did this run follow".
 *
 * Scoping is asserted the same way `queries.test.ts` asserts every other id-taking read: over the
 * two-profile fixture, with the out-of-scope refusal proved identical — code **and** message — to
 * the refusal for a run that never existed.
 *
 * Skipped — not failed — when `SISYPHUS_TEST_DATABASE_URL` is absent.
 */

const connectionString = readTestDatabaseUrl()

/** The convention as it stood when run A read it. */
const DIGEST_BEFORE = 'b'.repeat(64)
/** The same file, edited, as run B read it. The only thing distinguishing the two versions. */
const DIGEST_AFTER = 'c'.repeat(64)

const readout = (over: Partial<SkillReferenceReadout> = {}): SkillReferenceReadout => ({
  id: randomUUID(),
  skillName: 'sisyphus-dev',
  entryId: null,
  resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
  contentDigest: DIGEST_BEFORE,
  phase: 'agent_start',
  unavailableReason: null,
  recordedAt: new Date('2026-08-01T09:00:00.000Z'),
  ...over,
})

describe('classifying one reference', () => {
  it('counts a path with a digest as resolved', () => {
    expect(isResolvedSkill(readout())).toBe(true)
  })

  it('counts a recorded absence as unresolved (FR-058)', () => {
    expect(isResolvedSkill(readout({ resolvedPath: null, contentDigest: null }))).toBe(false)
  })
})

describe('summarising a run’s skill record', () => {
  it('names the skills that could not be resolved rather than dropping them', () => {
    const summary = summariseSkillReferences([
      readout(),
      readout({
        skillName: 'sisyphus-review',
        resolvedPath: null,
        contentDigest: null,
        unavailableReason: 'The skill document is absent from the repository.',
      }),
    ])

    expect(summary.resolvedCount).toBe(1)
    expect(summary.unavailableSkills).toStrictEqual(['sisyphus-review'])
    // A recorded absence is an explanation, not a gap in one.
    expect(summary.explicable).toBe(true)
  })

  it('reports a resolution recorded without its digest as inexplicable', () => {
    // The one shape FR-059 rules out: the run read something and nothing says which version.
    const summary = summariseSkillReferences([readout({ contentDigest: null })])

    expect(summary.explicable).toBe(false)
    expect(summary.resolvedCount).toBe(0)
  })
})

describe.skipIf(connectionString === undefined)('reading a run’s skills (FR-059, FR-190)', () => {
  let fixture: TwoProfileFixture
  let db: SisyphusDatabase
  let ids: TwoProfileIds

  let aliceScope: ResolvedScope
  let bobScope: ResolvedScope
  let adminScope: ResolvedScope

  beforeAll(async () => {
    fixture = createTwoProfileFixture(connectionString ?? '')
    await fixture.open()
    db = fixture.db()
    ids = fixture.ids()

    // The same skill name, read by two runs, at two versions. Run A is the older one.
    await db.insert(skillReferences).values([
      {
        workflowId: ids.a.workflowId,
        skillName: 'sisyphus-dev',
        entryId: ids.a.workflowEntryId,
        resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
        contentDigest: DIGEST_BEFORE,
        phase: 'agent_start',
        recordedAt: new Date('2026-08-01T09:00:00.000Z'),
      },
      {
        workflowId: ids.a.workflowId,
        skillName: 'sisyphus-review',
        entryId: ids.a.workflowEntryId,
        resolvedPath: null,
        contentDigest: null,
        phase: 'agent_start',
        unavailableReason: 'The skill document is absent from the repository.',
        recordedAt: new Date('2026-08-01T09:00:05.000Z'),
      },
      {
        workflowId: ids.b.workflowId,
        skillName: 'sisyphus-dev',
        entryId: ids.b.workflowEntryId,
        resolvedPath: '.claude/skills/sisyphus-dev/SKILL.md',
        contentDigest: DIGEST_AFTER,
        phase: 'agent_start',
        recordedAt: new Date('2026-08-20T09:00:00.000Z'),
      },
    ])

    aliceScope = await fixture.scopeFor(ids.alice)
    bobScope = await fixture.scopeFor(ids.bob)
    adminScope = await fixture.scopeFor(ids.admin, true)
  }, 60_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it('answers with the version the run read, not the version that came after it', async () => {
    const earlier = await readSkillReferences({
      db,
      scope: adminScope,
      workflowId: ids.a.workflowId,
    })
    const later = await readSkillReferences({ db, scope: adminScope, workflowId: ids.b.workflowId })

    const digestOf = (references: readonly SkillReferenceReadout[]): string | null =>
      references.find((reference) => reference.skillName === 'sisyphus-dev')?.contentDigest ?? null

    // The skill has since changed — `later` is what the file became — and the earlier run still
    // reports what it actually followed. This is the whole of FR-059.
    expect(digestOf(earlier)).toBe(DIGEST_BEFORE)
    expect(digestOf(later)).toBe(DIGEST_AFTER)
    expect(digestOf(earlier)).not.toBe(digestOf(later))
  })

  it('returns the recorded absence alongside the resolution (FR-058)', async () => {
    const summary = summariseSkillReferences(
      await readSkillReferences({ db, scope: aliceScope, workflowId: ids.a.workflowId }),
    )

    expect(summary.references).toHaveLength(2)
    expect(summary.resolvedCount).toBe(1)
    expect(summary.unavailableSkills).toStrictEqual(['sisyphus-review'])
    expect(summary.references[1]?.unavailableReason).toContain('absent from the repository')
  })

  it('orders oldest first, because the sequence is how the run proceeded', async () => {
    const references = await readSkillReferences({
      db,
      scope: aliceScope,
      workflowId: ids.a.workflowId,
    })

    expect(references.map((reference) => reference.skillName)).toStrictEqual([
      'sisyphus-dev',
      'sisyphus-review',
    ])
  })

  it('lets each grant holder read their own run’s skills', async () => {
    await expect(
      readSkillReferences({ db, scope: aliceScope, workflowId: ids.a.workflowId }),
    ).resolves.toHaveLength(2)
    await expect(
      readSkillReferences({ db, scope: bobScope, workflowId: ids.b.workflowId }),
    ).resolves.toHaveLength(1)
  })

  it('refuses the ungranted run with NOT_FOUND, never FORBIDDEN (FR-190)', async () => {
    const refusal = await refusalOf(() =>
      readSkillReferences({ db, scope: aliceScope, workflowId: ids.b.workflowId }),
    )

    expect(refusal).toBeInstanceOf(TRPCError)
    expect(refusal.code).toBe('NOT_FOUND')
    // Stated separately: FORBIDDEN is the intuitive code and it answers "does this run exist?"
    // with yes, which is the disclosure FR-190 prohibits.
    expect(refusal.code).not.toBe('FORBIDDEN')
  })

  it('is indistinguishable from a run that never existed — code and message', async () => {
    const outOfScope = await refusalOf(() =>
      readSkillReferences({ db, scope: aliceScope, workflowId: ids.b.workflowId }),
    )
    const missing = await refusalOf(() =>
      readSkillReferences({ db, scope: aliceScope, workflowId: randomUUID() }),
    )

    expect(outOfScope.code).toBe(missing.code)
    expect(outOfScope.message).toBe(missing.message)
  })

  it('does not answer an out-of-scope run with an empty list, which would confirm it exists', async () => {
    // Bob's run has exactly one reference. An implementation that filtered rows instead of gating
    // on the parent would return `[]` here and look harmless.
    await expect(
      readSkillReferences({ db, scope: aliceScope, workflowId: ids.b.workflowId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
