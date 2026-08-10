/**
 * The executor's output pipeline (T058, T059, T060, T198).
 *
 * Consumers import from here and never from the modules behind it. The order
 * the stages run in — strip, then redact, then segment — is a property of
 * `createSegmentWriter`, not of whoever calls it, and the barrel exists partly
 * to keep it that way: there is no supported way to reach the segment sinks
 * without going through the sanitiser first.
 *
 * ## The redaction stage now lives in `@bluetel-ai/sisyphus-redaction`
 *
 * T198 moved it there — one implementation, two apps — because FR-163 requires
 * the control plane to redact an assembled prompt "to the same standard as run
 * output", and an app must not depend on another app. Nothing about the
 * pipeline changed: the redactor is re-exported here so this barrel is still
 * the executor's single output surface and no module in `run/`, `delivery/` or
 * `bootstrap/` had to learn a second import path. What stayed behind is
 * everything about a *terminal* — control stripping, the screen buffer,
 * spinner frames, segmentation, the token bucket — plus the three modules that
 * decide which values a run knows: `agent-credential.ts`, `bundle-secrets.ts`
 * and `secret-registry.ts`. Those are facts about a run, not about redaction,
 * and they cross the boundary as `KnownSecret` and `SecretSource`.
 */

export {
  buildSecretIndex,
  createKeyBlockFilter,
  createRedactor,
  createStreamingRedactor,
  MIN_SECRET_LENGTH,
  PRIVATE_KEY_PLACEHOLDER,
  redactPatterns,
  SECRET_PATTERNS,
  secretEncodings,
  stripPrivateKeyBlocks,
} from '@bluetel-ai/sisyphus-redaction'
export type {
  KeyBlockFilter,
  KnownSecret,
  Redactor,
  RedactorOptions,
  SecretIndex,
  SecretPattern,
  SecretSource,
  StreamingRedactor,
} from '@bluetel-ai/sisyphus-redaction'

export { AGENT_CREDENTIAL_SECRET_NAME, agentCredentialSecret } from './agent-credential'

// Only the composition site's entry point. The parsing rules underneath it — which strings in a
// credential file are values, and what they are named — are this directory's business and are
// exercised by the module's own colocated suite.
export { bundleCredentialSecrets } from './bundle-secrets'

export { scanControlTokens } from './control-tokens'
export type { ControlToken, ControlTokenScan, ControlTokenScanOptions } from './control-tokens'

export { createSanitiser, EMPTY_SANITISED_TEXT, sanitise, sanitisedByteLength } from './sanitise'
export type { Sanitiser, SanitiserOptions, SanitisedText } from './sanitise'

export { createScreenBuffer } from './screen-buffer'
export type { RenderedRow, ScreenBuffer } from './screen-buffer'

export { createSecretRegistry } from './secret-registry'
export type { SecretRegistry } from './secret-registry'

export { createSegmentWriter } from './segments'
export type {
  LogSegmentRecord,
  SegmentReporter,
  SegmentStore,
  SegmentWriter,
  SegmentWriterOptions,
} from './segments'

export { isSpinnerOnlyLine, stripLeadingSpinnerGlyph } from './spinner-frames'

export {
  createControlStripper,
  DEFAULT_RETAINED_ROWS,
  stripControlSequences,
} from './strip-control'
export type { ControlStripper, ControlStripperOptions } from './strip-control'

export { createTokenBucket } from './token-bucket'
export type { TokenBucket, TokenBucketOptions } from './token-bucket'
