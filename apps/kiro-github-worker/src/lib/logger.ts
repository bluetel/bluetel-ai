import pino from 'pino'

/**
 * Creates a pino logger instance configured for structured JSON output to stdout.
 *
 * @param level - Log level: 'debug' | 'info' | 'warn' | 'error'
 * @returns A pino logger instance
 *
 * Use `.child()` to add contextual fields like `repo`, `issueNumber`, and `step`:
 *
 * ```ts
 * const logger = createLogger('info');
 * const child = logger.child({ repo: 'org/repo', issueNumber: 42, step: 'clone' });
 * child.info('Cloning repository');
 * ```
 */
export const createLogger = (level: string): pino.Logger =>
  pino({
    level,
  })
