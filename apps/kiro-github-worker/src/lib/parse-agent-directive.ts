/**
 * Scans text for a line matching `agent: {name}` (case-insensitive key).
 * Returns the first matched agent name, or undefined.
 */
export const parseAgentDirective = (text: string): string | undefined => {
  const match = /^agent:\s*(\S+)\s*$/im.exec(text)
  return match?.[1]
}
