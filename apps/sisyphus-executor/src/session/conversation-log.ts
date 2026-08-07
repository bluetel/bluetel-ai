/**
 * **The agent's conversation state on disk (T097, T098, FR-051, FR-053, R2).**
 *
 * These four functions were written for spike S2 and are promoted here rather than thrown away
 * with the harness, exactly as `SPIKE-FINDINGS.md` says they would be. `spike-restore.ts` now
 * imports them, so the thing the spike exercised and the thing the restore path uses are one
 * implementation rather than two that agree today.
 *
 * ## What the spike proved about them, and what it did not
 *
 * Proved, against the real `claude` installation on the machine the spike ran on: sessions live at
 * `<config dir>/projects/<absolute cwd with non-alphanumerics replaced by dashes>/<session>.jsonl`,
 * and each log line carries a top-level `sessionId`. {@link mangleWorkspacePath} is that naming
 * rule, and it is the whole reason R2 pins the workspace root — the mangled directory name is
 * reproducible on a fresh instance only because the absolute path is identical there.
 *
 * Not proved: that the real agent **accepts** a restored tree. `--resume` was never run, because
 * running it costs a prompted session. So "the session is findable and the log parses" is the
 * claim these functions support, and it is a claim about files rather than about the agent.
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Directory name the agent derives from an absolute working directory. */
export const mangleWorkspacePath = (absolutePath: string): string =>
  absolutePath.replace(/[^A-Za-z0-9._-]/g, '-')

/** Where conversation logs live, given the relocated config directory. */
export const sessionLogDirectory = (configDir: string, workspaceRoot: string): string =>
  join(configDir, 'projects', mangleWorkspacePath(workspaceRoot))

export interface ConversationLog {
  readonly entries: readonly Record<string, unknown>[]
  /**
   * True when a trailing line did not parse and was discarded. This is a
   * normal path, not an error path: the log is append-only and is not written
   * atomically, so a crash mid-write leaves a partial final line (FR-053).
   */
  readonly truncationRepaired: boolean
  readonly linesRead: number
}

/**
 * Parse an append-only conversation log line by line.
 *
 * A trailing line that does not parse is dropped. A line that does not parse
 * anywhere **else** is a different problem and is reported rather than
 * silently tolerated, because that is corruption rather than truncation.
 */
export const parseConversationLog = (contents: string): ConversationLog => {
  const lines = contents.split('\n').filter((line) => line !== '')
  const entries: Record<string, unknown>[] = []
  let truncationRepaired = false

  for (const [index, line] of lines.entries()) {
    try {
      const parsed: unknown = JSON.parse(line)

      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as Record<string, unknown>)
      }
    } catch (error) {
      if (index === lines.length - 1) {
        truncationRepaired = true

        continue
      }

      throw new Error(`conversation log line ${index + 1} of ${lines.length} does not parse`, {
        cause: error,
      })
    }
  }

  return { entries, truncationRepaired, linesRead: lines.length }
}

/** Session identifiers discoverable at the pinned path, newest name last. */
export const discoverSessionIds = async (logDirectory: string): Promise<readonly string[]> => {
  if (!existsSync(logDirectory)) {
    return []
  }

  const names = await readdir(logDirectory)

  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort()
}
