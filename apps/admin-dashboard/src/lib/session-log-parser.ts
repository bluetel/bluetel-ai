export interface SessionLogMetadata {
  timestamp: string
  engine: string
  repository: string
  context: string
  exitCode: number
  success: boolean
}

const HEADER_START = '=== SESSION LOG ==='
const HEADER_END = '================'

/**
 * Parses the metadata header from session log file content.
 * Extracts fields between `=== SESSION LOG ===` and `================` markers.
 * Returns null if the header is missing or malformed.
 */
export const parseSessionLogMetadata = (content: string): SessionLogMetadata | null => {
  const startIndex = content.indexOf(HEADER_START)
  if (startIndex === -1) return null

  const afterStart = startIndex + HEADER_START.length
  const endIndex = content.indexOf(HEADER_END, afterStart)
  if (endIndex === -1) return null

  const headerBlock = content.slice(afterStart, endIndex)
  const lines = headerBlock.split('\n').filter((line) => line.trim() !== '')

  const fields: Partial<Record<string, string>> = {}
  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const key = line.slice(0, colonIndex).trim().toLowerCase()
    const value = line.slice(colonIndex + 1).trim()
    fields[key] = value
  }

  const timestamp = fields['timestamp']
  const engine = fields['engine']
  const repository = fields['repository']
  const context = fields['context']
  const exitCodeStr = fields['exit code']
  const successStr = fields['success']

  if (
    timestamp === undefined ||
    engine === undefined ||
    repository === undefined ||
    context === undefined ||
    exitCodeStr === undefined ||
    successStr === undefined
  ) {
    return null
  }

  const exitCode = parseInt(exitCodeStr, 10)
  if (isNaN(exitCode)) return null

  const success = successStr.toLowerCase() === 'true'

  return {
    timestamp,
    engine,
    repository,
    context,
    exitCode,
    success,
  }
}
