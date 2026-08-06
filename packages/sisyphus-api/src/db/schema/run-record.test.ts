import { describe, expect, it } from 'vitest'

import { columnOf, describeTable, indexOf, referencedTables } from './introspect'
import { artifacts, logSegments, sessionSnapshots, skillReferences } from './run-record'

describe('log_segments', () => {
  it('reconciles by sequence, not by arrival time (FR-046)', () => {
    const index = indexOf(logSegments, 'log_segments_sequence_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id', 'sequence'])
  })

  it('uses bigint for the sequence, which a long run outgrows in 32 bits', () => {
    expect(columnOf(logSegments, 'sequence').type).toBe('bigint')
    expect(columnOf(logSegments, 'byte_size').type).toBe('bigint')
  })

  it('holds a key, never the content, so nothing unsanitised exists at rest (FR-019)', () => {
    const names = describeTable(logSegments).columns.map((column) => column.name)
    expect(names).toContain('s3_key')
    expect(names).not.toContain('content')
    expect(names).not.toContain('body')
  })
})

describe('session_snapshots', () => {
  it('records both state flags, because a snapshot missing either is not resumable (FR-050)', () => {
    expect(columnOf(sessionSnapshots, 'has_conversation_state').notNull).toBe(true)
    expect(columnOf(sessionSnapshots, 'has_worktree_state').notNull).toBe(true)
  })

  it('allows exactly one current snapshot per workflow (FR-050)', () => {
    const index = indexOf(sessionSnapshots, 'session_snapshots_current_key')
    expect(index.unique).toBe(true)
    expect(index.columns).toStrictEqual(['workflow_id'])
    expect(index.where).toBe('"session_snapshots"."is_current"')
  })

  it('records a repaired truncation as a normal outcome, not a corruption (FR-053)', () => {
    expect(columnOf(sessionSnapshots, 'truncation_repaired').notNull).toBe(true)
    expect(columnOf(sessionSnapshots, 'truncation_repaired').defaultValue).toBe(false)
  })

  it('names why the snapshot was taken, so all four suspend paths are distinguishable (R3)', () => {
    expect(columnOf(sessionSnapshots, 'boundary').type).toBe('snapshot_boundary')
    expect(columnOf(sessionSnapshots, 'boundary').notNull).toBe(true)
  })

  it('requires an expiry, which is what refuses a successor from an expired snapshot', () => {
    expect(columnOf(sessionSnapshots, 'expires_at').notNull).toBe(true)
  })

  it('pins the session id the agent was started with (FR-052)', () => {
    expect(columnOf(sessionSnapshots, 'session_id').type).toBe('uuid')
    expect(columnOf(sessionSnapshots, 'session_id').notNull).toBe(true)
  })
})

describe('artifacts', () => {
  it('enumerates a workflow without listing an S3 prefix and guessing (FR-014)', () => {
    expect(indexOf(artifacts, 'artifacts_workflow_kind_idx').columns).toStrictEqual([
      'workflow_id',
      'kind',
    ])
  })

  it('allows either an S3 object or an external URL, since a PR lives elsewhere', () => {
    expect(columnOf(artifacts, 's3_key').notNull).toBe(false)
    expect(columnOf(artifacts, 'external_url').notNull).toBe(false)
  })

  it('keeps the row after the object expires, so a gap reads as retention not loss', () => {
    expect(columnOf(artifacts, 'expires_at').notNull).toBe(false)
    expect(columnOf(artifacts, 'created_at').notNull).toBe(true)
  })

  it('anchors an artifact to an entry when it belongs to one repository', () => {
    expect(columnOf(artifacts, 'entry_id').notNull).toBe(false)
    expect([...referencedTables(artifacts)].sort()).toStrictEqual(['workflow_entries', 'workflows'])
  })
})

describe('skill_references', () => {
  it('records the digest, because that is the only version a repository file has (FR-059)', () => {
    expect(columnOf(skillReferences, 'content_digest').type).toBe('text')
  })

  it('allows a null path and digest, so an unreadable skill is a recorded fact (FR-058)', () => {
    expect(columnOf(skillReferences, 'resolved_path').notNull).toBe(false)
    expect(columnOf(skillReferences, 'content_digest').notNull).toBe(false)
    expect(columnOf(skillReferences, 'unavailable_reason').notNull).toBe(false)
  })

  it('constrains the skill name to the closed set', () => {
    expect(columnOf(skillReferences, 'skill_name').type).toBe('skill_name')
    expect(columnOf(skillReferences, 'skill_name').notNull).toBe(true)
  })

  it('indexes the "explain a past run" query (SC-016)', () => {
    expect(indexOf(skillReferences, 'skill_references_workflow_idx').columns).toStrictEqual([
      'workflow_id',
      'skill_name',
    ])
  })
})
