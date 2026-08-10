/**
 * The platform's secret-redaction standard (T198, FR-019, FR-163).
 *
 * ## What "the standard" is
 *
 * Three stages, in this order, and the order is the standard as much as the stages are:
 *
 * 1. **Private-key blocks.** A PEM block is suppressed whole, because its body is base64 and
 *    matches nothing on a line-by-line reading.
 * 2. **Known values.** Every credential the caller was handed, removed verbatim and in every
 *    encoding derivable from the value alone — this is what catches a client credential in a format
 *    nobody anticipated.
 * 3. **Patterns.** The credential shapes that can be described in advance, which is the only way to
 *    catch a credential nobody handed us: one an agent minted mid-run, or a reporter pasted into a
 *    ticket.
 *
 * Known values run before patterns so a credential is labelled by the caller's name for it rather
 * than by whichever pattern happens to also match.
 *
 * ## Why this is a package rather than a directory in the executor
 *
 * It began as `apps/sisyphus-executor/src/output/`, because run output was the only thing that
 * needed redacting. It is not any more. FR-163 requires an integration-assembled prompt to be
 * redacted **to the same standard as run output** before it is stored, and that assembly happens in
 * `apps/sisyphus-control-plane` — a second app. An app must not depend on another app, so with the
 * standard living inside the executor there were only two ways to satisfy FR-163: reimplement it in
 * the control plane, or wire nothing. The repository did the second — `context.ts` defaulted to a
 * redactor that refuses, and every integration tick with a candidate ticket threw. The first would
 * have been worse: two implementations of a redaction standard drift on the first pattern anyone
 * adds to one of them, and the half that drifts is the half nobody is looking at.
 *
 * So the standard is a package both apps depend on, and there is still exactly one implementation
 * of it. This follows the shape T206 established when `apps/sisyphus-control-plane/src/notify/`
 * became `@bluetel-ai/sisyphus-notify` for the same reason: two apps, one path, no app-to-app edge.
 *
 * ## What deliberately stayed behind
 *
 * The executor's `src/output/` keeps everything that is about a *terminal*: control-sequence
 * stripping, the screen buffer, spinner-frame suppression, segmentation and the token bucket
 * (FR-019's other half). It also keeps the three modules that decide *which values* a run knows —
 * the setup bundle's credentials, the agent's own rotating credential, and the registry that holds
 * them — because those are facts about a run, not about redaction. They cross this boundary as
 * {@link KnownSecret} and {@link SecretSource}, which is the whole contract.
 *
 * **This package reaches nothing.** No client, no filesystem, no environment: it is a pure function
 * of the text and the values it was given, which is what makes it safe for the control plane's
 * Lambda and the executor's long-lived process to share.
 *
 * Consumers import this barrel, never a module underneath it.
 */

export { createKeyBlockFilter, PRIVATE_KEY_PLACEHOLDER, stripPrivateKeyBlocks } from './key-blocks'
export type { KeyBlockFilter } from './key-blocks'

export { createRedactor, createStreamingRedactor } from './redact'
export type { Redactor, RedactorOptions, StreamingRedactor } from './redact'

export { MIN_SECRET_LENGTH, secretEncodings } from './secret-encodings'

export { redactPatterns, SECRET_PATTERNS } from './secret-patterns'
export type { SecretPattern } from './secret-patterns'

export { buildSecretIndex } from './secret-values'
export type { KnownSecret, SecretIndex, SecretSource } from './secret-values'
