/**
 * Runtime membership guards for the closed vocabularies in this directory.
 *
 * Every enum here is a `readonly` tuple rather than a TypeScript `enum`, so the values survive
 * `isolatedModules`, can be handed straight to Drizzle's `pgEnum`, and are usable from a browser
 * bundle. The tuple is the single source; the union type and the guard are both derived from it,
 * so a value can never be added in one place and missed in another (FR-009).
 */

/**
 * Build a type guard for a closed set of string values.
 *
 * The guard narrows `unknown`, not `string`, because the values it is asked about arrive from
 * request bodies, environment variables and database rows — none of which are typed on arrival.
 */
export const createEnumGuard =
  <TValue extends string>(values: readonly TValue[]) =>
  (candidate: unknown): candidate is TValue =>
    typeof candidate === 'string' && (values as readonly string[]).includes(candidate)
