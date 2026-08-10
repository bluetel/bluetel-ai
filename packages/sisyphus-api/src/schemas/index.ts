/**
 * Zod input schemas — one source for the resolvers and for the panel's forms.
 *
 * Re-exported from `@bluetel-ai/sisyphus-api/client`, so both sides consume the *same* object:
 * the resolver passes it to `.input()` and the panel passes it to its form resolver. That is what
 * makes the flattened `data.zodError` useful — field-level rendering needs the client to know the
 * same field names the server validated, and two schemas that agree today would not stay agreed
 * (FR-008, api-surface.md → Input schemas live with the contract).
 *
 * Nothing here imports from `src/db/` or `src/server/`: this barrel must stay safe in a browser
 * bundle.
 */

export {
  cursorPagination,
  dateRange,
  enabledFlag,
  moneyAmount,
  nonEmptyText,
  pageLimit,
  uuidInput,
} from './common'
export type { CursorPagination, DateRange, UuidInput } from './common'

export * from './workflow'
export * from './notification'
export * from './machine'
export * from './bundle'
export * from './workspace'
export * from './profile'
export * from './integration'
export * from './access'
export * from './credential'
