/**
 * Defensive NDJSON frame parsing for the CLI adapter (T056).
 *
 * The wire format is documented only at the flag level (R1). Spike S1 recovered
 * the frame vocabulary — `system`, `assistant`, `user`, `result`,
 * `stream_event`, `control_request`, `control_response` — from the shipped
 * binary's own strings rather than from documentation, which is the strongest
 * evidence available and still not a specification. A future CLI release may
 * add a type, add a field, or change a payload shape without telling us.
 *
 * So the rule here is absolute: **parsing never throws and never terminates a
 * run.** A line this module does not understand becomes an
 * {@link AgentUnknownFrame} carrying the original text, which the adapter logs
 * and skips. A schema that rejects an unfamiliar discriminant would turn a
 * cosmetic upstream addition into a dead workflow on a paid instance, which is
 * precisely the failure this file exists to prevent.
 *
 * "Defensive" is scoped, not unlimited. Exactly four things produce an unknown
 * frame — unparsable JSON, a non-object, a missing or non-string `type`, and a
 * `type` outside the modelled set. Everything else is read leniently: a known
 * type with a field missing or a payload shaped unexpectedly still arrives as
 * that type with whatever could be read. Degrading a familiar frame to
 * `unknown` because one field moved would make an ordinary `assistant` frame
 * carrying only tool-use blocks look like a protocol break, and a stream of
 * those would drown the signal that something is genuinely wrong.
 */

import type {
  AgentAssistantFrame,
  AgentFrame,
  AgentResultFrame,
  AgentSystemFrame,
  AgentUnknownFrame,
  AgentUsage,
} from './adapter'

/**
 * Frame types this module models. Others — `stream_event`, `control_request`,
 * `control_response` — are real and deliberately left out of the model:
 * nothing in the executor consumes them, so they arrive as unknown frames and are skipped
 * rather than given a half-built representation nobody reads.
 */
export const MODELLED_FRAME_TYPES = ['system', 'assistant', 'user', 'result'] as const

export type ModelledFrameType = (typeof MODELLED_FRAME_TYPES)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]

  return typeof value === 'string' ? value : undefined
}

const readNumber = (source: Record<string, unknown>, key: string): number | undefined => {
  const value = source[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Pull display text out of a message payload.
 *
 * Both content shapes are accepted — a bare string and a list of typed blocks —
 * because S1 established that the stub accepts both and did **not** establish
 * which the real CLI emits. Accepting both costs nothing; guessing one costs a
 * silently empty log.
 */
export const readMessageText = (frame: Record<string, unknown>): string => {
  const message = frame['message']

  if (!isRecord(message)) {
    return ''
  }

  const content = message['content']

  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter(isRecord)
    .filter((block) => block['type'] === 'text')
    .map((block) => block['text'])
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

/**
 * Usage as at a `result` frame.
 *
 * `num_turns` and `total_cost_usd` are the field names S1 read out of the
 * binary. A frame carrying neither yields zeroes rather than an error: the
 * adapter keeps usage monotonic, so a frame that reports nothing leaves the
 * previous figures standing instead of resetting them.
 */
export const readResultUsage = (frame: Record<string, unknown>): AgentUsage => ({
  turns: readNumber(frame, 'num_turns') ?? 0,
  spendUsd: readNumber(frame, 'total_cost_usd') ?? 0,
})

const unknownFrame = (raw: string): AgentUnknownFrame => ({ type: 'unknown', raw })

const sessionIdOf = (frame: Record<string, unknown>): { sessionId?: string } => {
  const sessionId = readString(frame, 'session_id')

  return sessionId === undefined ? {} : { sessionId }
}

const systemFrame = (frame: Record<string, unknown>): AgentSystemFrame => ({
  type: 'system',
  // Never narrowed to a closed union — an unfamiliar subtype is information.
  subtype: readString(frame, 'subtype') ?? 'unspecified',
  ...sessionIdOf(frame),
})

const assistantFrame = (frame: Record<string, unknown>): AgentAssistantFrame => ({
  type: 'assistant',
  text: readMessageText(frame),
  ...sessionIdOf(frame),
})

const resultFrame = (frame: Record<string, unknown>): AgentResultFrame => ({
  type: 'result',
  subtype: readString(frame, 'subtype') ?? 'unspecified',
  isError: frame['is_error'] === true,
  usage: readResultUsage(frame),
  ...sessionIdOf(frame),
})

/**
 * Parse one NDJSON line.
 *
 * Total by construction: every input produces a frame, and the caller has no
 * error path to forget to handle. A blank line is the one input that produces
 * nothing at all, because a trailing newline is not a protocol event.
 */
export const parseFrameLine = (line: string): AgentFrame | undefined => {
  if (line.trim() === '') {
    return undefined
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(line)
  } catch {
    return unknownFrame(line)
  }

  if (!isRecord(parsed)) {
    return unknownFrame(line)
  }

  const type = readString(parsed, 'type')

  switch (type) {
    case 'system':
      return systemFrame(parsed)
    case 'assistant':
      return assistantFrame(parsed)
    case 'user':
      return { type: 'user', text: readMessageText(parsed), ...sessionIdOf(parsed) }
    case 'result':
      return resultFrame(parsed)
    default:
      return unknownFrame(line)
  }
}

/**
 * The user-turn frame written to the agent's stdin.
 *
 * The block-list shape rather than a bare string, matching what S1's harness
 * proved deliverable mid-request. Which shape the real CLI accepts was **not**
 * observed, so this is a choice made on the best evidence available and is the
 * single place to change if a real invocation says otherwise.
 */
export const encodeUserTurn = (body: string): string =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: body }] },
  })

export interface FrameDecoder {
  /** Feed a stdout chunk; returns every frame completed by it. */
  readonly push: (chunk: string) => readonly AgentFrame[]
  /** Emit whatever a final line without a trailing newline left behind. */
  readonly flush: () => readonly AgentFrame[]
}

/**
 * Reassemble frames from arbitrarily split stdout chunks.
 *
 * A pipe read boundary lands wherever the kernel puts it, so a chunk routinely
 * ends mid-line and occasionally mid-multibyte-character. Holding the tail
 * until a newline arrives is what stops a perfectly valid frame from being
 * reported as unparsable purely because it was read in two pieces.
 */
export const createFrameDecoder = (): FrameDecoder => {
  let pending = ''

  const drain = (text: string): readonly AgentFrame[] => {
    const frames: AgentFrame[] = []

    for (const line of text.split('\n')) {
      const frame = parseFrameLine(line)

      if (frame !== undefined) {
        frames.push(frame)
      }
    }

    return frames
  }

  return {
    push: (chunk: string): readonly AgentFrame[] => {
      const combined = pending + chunk
      const lastBreak = combined.lastIndexOf('\n')

      if (lastBreak === -1) {
        pending = combined

        return []
      }

      pending = combined.slice(lastBreak + 1)

      return drain(combined.slice(0, lastBreak))
    },
    flush: (): readonly AgentFrame[] => {
      const remainder = pending

      pending = ''

      return drain(remainder)
    },
  }
}
