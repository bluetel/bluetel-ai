import pino from 'pino'

/**
 * Creates a pino logger instance configured for structured JSON output to stdout.
 *
 * @param level - Log level: 'debug' | 'info' | 'warn' | 'error'
 * @returns A pino logger instance
 *
 * Use `.child()` to add contextual fields like `mentionIdentity`, `repo`, and `sourceType`:
 *
 * ```ts
 * const logger = createLogger('info');
 * const child = logger.child({
 *   mentionIdentity: 'owner/repo:issue_comment:42',
 *   repo: 'owner/repo',
 *   sourceType: 'issue_comment',
 * });
 * child.info('Mention dequeued');
 * ```
 */
export const createLogger = (level: string): pino.Logger =>
  pino({
    level,
  })
