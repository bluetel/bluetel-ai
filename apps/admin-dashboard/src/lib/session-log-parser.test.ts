import { describe, it, expect } from 'vitest'

import { parseSessionLogMetadata } from './session-log-parser'

describe('parseSessionLogMetadata', () => {
  it('parses a valid session log header', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: 0
Success: true
================

Some log content here...`

    const result = parseSessionLogMetadata(content)

    expect(result).toEqual({
      timestamp: '2024-01-15T10:30:00Z',
      engine: 'kiro',
      repository: 'org/repo',
      context: 'issue-123',
      exitCode: 0,
      success: true,
    })
  })

  it('parses a header with non-zero exit code and success false', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2026-05-13T09:53:33.866Z
Engine: copilot
Repository: bluetel/sports-pro-iq-expo
Context: task-6fe5f9b2-3e8e-41c4-a2af-1babf809af78
Exit Code: 1
Success: false
================
`

    const result = parseSessionLogMetadata(content)

    expect(result).toEqual({
      timestamp: '2026-05-13T09:53:33.866Z',
      engine: 'copilot',
      repository: 'bluetel/sports-pro-iq-expo',
      context: 'task-6fe5f9b2-3e8e-41c4-a2af-1babf809af78',
      exitCode: 1,
      success: false,
    })
  })

  it('returns null when header start marker is missing', () => {
    const content = `Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: 0
Success: true
================`

    expect(parseSessionLogMetadata(content)).toBeNull()
  })

  it('returns null when header end marker is missing', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: 0
Success: true`

    expect(parseSessionLogMetadata(content)).toBeNull()
  })

  it('returns null when a required field is missing', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Exit Code: 0
Success: true
================`

    expect(parseSessionLogMetadata(content)).toBeNull()
  })

  it('returns null when exit code is not a number', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: abc
Success: true
================`

    expect(parseSessionLogMetadata(content)).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(parseSessionLogMetadata('')).toBeNull()
  })

  it('handles content with extra whitespace in field values', () => {
    const content = `=== SESSION LOG ===
Timestamp:   2024-01-15T10:30:00Z  
Engine:  kiro  
Repository:  org/repo  
Context:  issue-123  
Exit Code:  0  
Success:  true  
================`

    const result = parseSessionLogMetadata(content)

    expect(result).toEqual({
      timestamp: '2024-01-15T10:30:00Z',
      engine: 'kiro',
      repository: 'org/repo',
      context: 'issue-123',
      exitCode: 0,
      success: true,
    })
  })

  it('handles content before the header markers', () => {
    const content = `Some preamble text
=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: 0
Success: true
================

Log output follows...`

    const result = parseSessionLogMetadata(content)

    expect(result).toEqual({
      timestamp: '2024-01-15T10:30:00Z',
      engine: 'kiro',
      repository: 'org/repo',
      context: 'issue-123',
      exitCode: 0,
      success: true,
    })
  })

  it('treats success field case-insensitively', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: 0
Success: True
================`

    const result = parseSessionLogMetadata(content)
    expect(result?.success).toBe(true)
  })

  it('treats non-true success values as false', () => {
    const content = `=== SESSION LOG ===
Timestamp: 2024-01-15T10:30:00Z
Engine: kiro
Repository: org/repo
Context: issue-123
Exit Code: 1
Success: false
================`

    const result = parseSessionLogMetadata(content)
    expect(result?.success).toBe(false)
  })
})
