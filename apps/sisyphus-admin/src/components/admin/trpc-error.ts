import type { FieldErrorContent } from '@sisyphus-admin/components/ui'

/**
 * Turning a refusal from the server into something an operator can act on (FR-031).
 *
 * `FieldErrorContent` requires a machine code **and** a next action, and that is the point: an
 * admin who is told "Something went wrong" has nothing to do and nothing to search for. So every
 * refusal this panel can receive is mapped, by tRPC error code, to a code that is quotable in a
 * ticket and a sentence that says what to do — and the mapping lives here rather than at each call
 * site, so two screens cannot describe the same refusal differently.
 *
 * The mapping is deliberately **not** the server's message. The server states why it refused;
 * `action` states what to do about it, which is a different sentence. Where the server's own words
 * add something the panel cannot know, the call site passes an override.
 */

/** The refusal codes this panel maps by name. Anything else falls through to the catch-all. */
export const MAPPED_TRPC_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'BAD_REQUEST',
  'CONFLICT',
  'PRECONDITION_FAILED',
] as const

export type MappedTrpcErrorCode = (typeof MAPPED_TRPC_ERROR_CODES)[number]

/**
 * Read the tRPC error code off whatever the mutation hook handed back.
 *
 * Typed as `unknown` rather than as `TRPCClientErrorLike`: the value reaching an error boundary or
 * an `onError` callback is only *usually* one of those, and a narrowing that assumes it is throws
 * a second time on the one occasion it is not.
 */
export const readTrpcErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined

  const { data } = error as { data?: unknown }
  if (typeof data !== 'object' || data === null) return undefined

  const { code } = data as { code?: unknown }
  return typeof code === 'string' ? code : undefined
}

/**
 * Whether the server answered "there is no such thing".
 *
 * The single most load-bearing check in the access UI. An out-of-scope read comes back as
 * `NOT_FOUND` precisely so the caller cannot tell it apart from a target that does not exist
 * (FR-190) — so the panel must render it as **not found**, never as "you do not have permission
 * to view this", which would put back the disclosure the error code was chosen to prevent.
 */
export const isNotFoundError = (error: unknown): boolean => readTrpcErrorCode(error) === 'NOT_FOUND'

const DEFAULT_CONTENT: Readonly<Record<MappedTrpcErrorCode, FieldErrorContent>> = {
  UNAUTHORIZED: {
    code: 'E_NOT_SIGNED_IN',
    action: 'Sign in again, then repeat the change.',
  },
  FORBIDDEN: {
    code: 'E_ADMIN_REQUIRED',
    action: 'Ask an active admin to make this change.',
  },
  NOT_FOUND: {
    code: 'E_TARGET_NOT_FOUND',
    action: 'Reload the list — what you were changing is no longer there.',
  },
  BAD_REQUEST: {
    code: 'E_INVALID_INPUT',
    action: 'Correct the highlighted value and submit again.',
  },
  CONFLICT: {
    code: 'E_ALREADY_CHANGED',
    action: 'Reload and read the current values — something else changed this first.',
  },
  PRECONDITION_FAILED: {
    code: 'E_PRECONDITION_FAILED',
    action: 'Reload and read the current values; the platform’s state forbids this change.',
  },
}

/**
 * Whether a code has an entry above. A guard rather than an index-and-check, so a code the server
 * grows tomorrow lands on the catch-all rather than on `undefined` typed as a `FieldErrorContent`.
 */
const isMappedCode = (code: string): code is MappedTrpcErrorCode =>
  MAPPED_TRPC_ERROR_CODES.some((mapped) => mapped === code)

/** The catch-all. Still a code and still an action, because a dead end is not allowed to exist. */
export const UNEXPECTED_ERROR: FieldErrorContent = {
  code: 'E_UNEXPECTED',
  action: 'Retry once. If it happens again, quote this code to the platform team.',
}

/**
 * Describe a refusal as a field error.
 *
 * @param error - Whatever the mutation or query rejected with.
 * @param overrides - Per-call replacements, keyed by tRPC code. A screen that knows what a
 *   particular code means *there* — `PRECONDITION_FAILED` on `admin.users` is always the
 *   never-zero-admins invariant — supplies the specific code and action here.
 * @returns A code and a next action. Never a dead end.
 */
export const describeTrpcError = (
  error: unknown,
  overrides: Partial<Record<string, FieldErrorContent>> = {},
): FieldErrorContent => {
  const code = readTrpcErrorCode(error)
  if (code === undefined) return UNEXPECTED_ERROR

  const override = overrides[code]
  if (override !== undefined) return override

  return isMappedCode(code) ? DEFAULT_CONTENT[code] : UNEXPECTED_ERROR
}
