/**
 * The pieces the admin screens share.
 *
 * Nothing here is a primitive — the panel has exactly one primitive set, in `src/components/ui`,
 * and everything below composes it. What lives here is the shared *behaviour* of the admin
 * surface: how a refusal is turned into a code and a next action, how a timestamp reads, how a
 * completed change reports itself, and what the panel renders when the server said `NOT_FOUND`.
 *
 * The two screens themselves are in `./users` and `./grants`, each with its own barrel.
 *
 * `AdminShell` used to be published here. It was never admin-only — half the workflow screens
 * mounted it — and it is no longer a shell: `src/app/(app)/layout.tsx` owns the framing, so what is
 * left is a per-screen heading block, published as `PageHeader` from `@sisyphus-admin/components/shell`.
 */

export { ChangeNotice } from './change-notice'

export { DataReadout } from './data-readout'

export { ElapsedReadout } from './elapsed-readout'
export { elapsedReadout, formatElapsed } from './format-elapsed'

export { formatTimestamp, NEVER } from './format-timestamp'

export { NotFoundCard } from './not-found-card'

export {
  describeTrpcError,
  isNotFoundError,
  MAPPED_TRPC_ERROR_CODES,
  readTrpcErrorCode,
  UNEXPECTED_ERROR,
} from './trpc-error'
export type { MappedTrpcErrorCode } from './trpc-error'
