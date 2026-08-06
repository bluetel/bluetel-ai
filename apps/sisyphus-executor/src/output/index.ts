/**
 * The executor's output pipeline (T058, T059, T060).
 *
 * Consumers import from here and never from the modules behind it. The order
 * the stages run in — strip, then redact, then segment — is a property of
 * `createSegmentWriter`, not of whoever calls it, and the barrel exists partly
 * to keep it that way: there is no supported way to reach the segment sinks
 * without going through the sanitiser first.
 */

export { scanControlTokens } from './control-tokens'
export type { ControlToken, ControlTokenScan, ControlTokenScanOptions } from './control-tokens'

export { createKeyBlockFilter, PRIVATE_KEY_PLACEHOLDER, stripPrivateKeyBlocks } from './key-blocks'
export type { KeyBlockFilter } from './key-blocks'

export { createRedactor, createStreamingRedactor } from './redact'
export type { Redactor, RedactorOptions, StreamingRedactor } from './redact'

export { createSanitiser, EMPTY_SANITISED_TEXT, sanitise, sanitisedByteLength } from './sanitise'
export type { Sanitiser, SanitiserOptions, SanitisedText } from './sanitise'

export { createScreenBuffer } from './screen-buffer'
export type { RenderedRow, ScreenBuffer } from './screen-buffer'

export { MIN_SECRET_LENGTH, secretEncodings } from './secret-encodings'

export { redactPatterns, SECRET_PATTERNS } from './secret-patterns'
export type { SecretPattern } from './secret-patterns'

export { buildSecretIndex } from './secret-values'
export type { KnownSecret, SecretIndex } from './secret-values'

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
