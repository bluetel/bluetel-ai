/**
 * Pattern-based redaction (T059, FR-045, FR-072).
 *
 * Stage one of the two-stage redactor: the credentials whose shape is known in
 * advance. It is the weaker half — it can only catch what someone thought to
 * describe — but it covers the case known-value matching cannot, which is a
 * credential the executor was never given: something the agent minted, read
 * out of a repository, or received from an API mid-run.
 *
 * Every pattern's first capture group is the part that is **kept**; the rest
 * of the match is replaced. That is what turns `AWS_SECRET_ACCESS_KEY=…` into
 * a line that still says which variable was set while saying nothing about
 * what it was set to. Patterns with nothing to keep open with an empty group.
 *
 * Over-matching is the intended failure direction. A redacted build number is
 * an inconvenience; a leaked token is an incident.
 */

/* cspell:ignore AKIA ASIA AGPA AIDA AROA AIPA ANPA ANVA ABIA ACCA AIza xoxb xoxp AAAA */

export interface SecretPattern {
  /** Appears in the placeholder. Describes the format, never the value. */
  readonly name: string
  /** Global. Capture group 1 is retained; everything after it is replaced. */
  readonly pattern: RegExp
}

/**
 * Ordered: the most specific formats first, so a token that also satisfies the
 * generic assignment pattern is labelled by what it actually is.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'aws-access-key-id',
    pattern: /()\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    name: 'repository-host-token',
    pattern: /()\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'repository-host-token',
    pattern: /()\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'api-key',
    pattern: /()\bsk-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'payment-provider-key',
    pattern: /()\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'cloud-api-key',
    pattern: /()\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  {
    name: 'chat-platform-token',
    pattern: /()\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'json-web-token',
    pattern: /()\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'authorization-header',
    pattern: /((?:proxy-)?authorization\s*[:=]\s*"?(?:bearer|basic|token)\s+)[^\s"',;]+/gi,
  },
  {
    name: 'bearer-token',
    pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  },
  {
    name: 'basic-credentials',
    pattern: /(\bBasic\s+)[A-Za-z0-9+/=]{16,}/g,
  },
  {
    name: 'url-credentials',
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g,
  },
  {
    name: 'assigned-secret',
    pattern:
      /(\b[A-Za-z0-9_.-]*(?:secret|token|password|passwd|apikey|api_key|access_key|private_key|credential|auth_?key)[A-Za-z0-9_.-]*"?\s*[:=]\s*"?)[^\s"',;[\]{}]{6,}/gi,
  },
]

/**
 * Replace every recognised credential format in `text`.
 *
 * The placeholder never encodes the length of what it replaced, so nothing
 * about the removed value survives inspection of the output.
 */
export const redactPatterns = (text: string): string => {
  let output = text

  for (const { name, pattern } of SECRET_PATTERNS) {
    output = output.replace(
      pattern,
      (_match: string, retained: string) => `${retained}[redacted:${name}]`,
    )
  }

  return output
}
