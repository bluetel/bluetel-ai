/**
 * Turning a thrown thing into a sentence an admin may read.
 *
 * Two jobs, and the second is the one with a requirement behind it:
 *
 * - **Say something useful.** "Validation failed" tells an admin nothing; `401 Unauthorized` tells
 *   them the token is wrong, and a JQL error tells them the project key is.
 * - **Never carry the credential out with it.** FR-072 and FR-098 say the credential does not
 *   appear in logs or integration run records, and a validation message is shown in the panel and
 *   kept on the run. An HTTP client that includes the request headers or the request URL in its
 *   error message is entirely ordinary, so the redaction is applied here rather than assumed
 *   upstream — the point of a rule like this is that it holds when somebody swaps the client.
 */

/** Long enough to be diagnostic, short enough not to paste a response body into a record. */
const MAX_LENGTH = 300

const REDACTIONS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Authorization headers, however they were stringified.
  { pattern: /\b(Basic|Bearer)\s+[\w.~+/=-]+/gi, replacement: '$1 [redacted]' },
  // Credentials in a URL: https://someone:token@example.atlassian.net. Greedy up to the last `@`
  // of the authority, because the user half is often an email address and carries one of its own.
  { pattern: /:\/\/[^/\s]*:[^/\s]*@/g, replacement: '://[redacted]@' },
  // Anything that named itself a token, key or password in a query string or a JSON fragment.
  {
    pattern:
      /\b(api[_-]?token|token|password|secret|apikey|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi,
    replacement: '$1$2[redacted]',
  },
]

const messageOf = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'An unrecognised failure was thrown.'
}

/**
 * @param error - Whatever was thrown.
 * @returns A short, credential-free description.
 */
export const sanitiseFailure = (error: unknown): string => {
  const redacted = REDACTIONS.reduce(
    (message, { pattern, replacement }) => message.replace(pattern, replacement),
    messageOf(error),
  )

  return redacted.length > MAX_LENGTH ? `${redacted.slice(0, MAX_LENGTH)}…` : redacted
}
