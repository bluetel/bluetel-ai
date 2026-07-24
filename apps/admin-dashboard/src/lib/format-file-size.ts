/**
 * Formats a byte count into a human-readable file size string.
 *
 * Uses the largest unit where the numeric value is >= 1, with at most 2 decimal places.
 * Returns "0 B" for 0 bytes.
 *
 * @example
 * formatFileSize(0)        // "0 B"
 * formatFileSize(512)      // "512 B"
 * formatFileSize(1536)     // "1.5 KB"
 * formatFileSize(3355443)  // "3.2 MB"
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const base = 1024

  let unitIndex = 0
  let value = bytes

  while (unitIndex < units.length - 1 && value >= base) {
    value /= base
    unitIndex++
  }

  // Round to at most 2 decimal places, removing trailing zeros
  const rounded = Math.round(value * 100) / 100
  const formatted = rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(2).replace(/0+$/, '')

  return `${formatted} ${units[unitIndex]}`
}
